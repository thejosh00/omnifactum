/**
 * The tickler: reminders that come back as next actions.
 *
 * Each item fires weekly, monthly or once, and each firing puts a task tagged `#tickler`
 * in next. The server does the firing on its timer; this page only lists, adds, edits
 * and deletes the items. See `db/tickler.ts` for why a firing sometimes holds off.
 */
import {useCallback, useEffect, useState, type FormEvent} from 'react';
import {describeSchedule, firstOn, shortDay, type Schedule} from '../core/recurrence.ts';
import {localDate} from '../core/time.ts';
import {api, ApiError, type TicklerJson} from './api.ts';
import {Confirm} from './Dialogs.tsx';

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

type Kind = Schedule['kind'];

interface Draft {
  title: string;
  kind: Kind;
  weekday: number;
  day: number;
  date: string;
}

function draftFrom(title: string, schedule: Schedule, today: string): Draft {
  const start = new Date(`${today}T12:00:00`);
  return {
    title,
    kind: schedule.kind,
    weekday: schedule.kind === 'weekly' ? schedule.weekday : start.getDay(),
    day: schedule.kind === 'monthly' ? schedule.day : start.getDate(),
    date: schedule.kind === 'once' ? schedule.date : today,
  };
}

function scheduleOf(draft: Draft): Schedule {
  switch (draft.kind) {
    case 'weekly':
      return {kind: 'weekly', weekday: draft.weekday};
    case 'monthly':
      return {kind: 'monthly', day: draft.day};
    case 'once':
      return {kind: 'once', date: draft.date};
  }
}

/** Title and schedule, shared by the add form and a row's edit form. */
function TicklerForm({
  initial,
  submit,
  today,
  onSubmit,
  onCancel,
}: {
  initial: Draft;
  submit: string;
  today: string;
  onSubmit: (title: string, schedule: Schedule) => Promise<boolean>;
  onCancel?: () => void;
}) {
  const [draft, setDraft] = useState(initial);
  const [busy, setBusy] = useState(false);
  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => setDraft(current => ({...current, [key]: value}));
  const schedule = scheduleOf(draft);
  const valid = draft.title.trim().length > 0 && (draft.kind !== 'once' || /^\d{4}-\d{2}-\d{2}$/.test(draft.date));

  const send = async (event: FormEvent) => {
    event.preventDefault();
    if (!valid || busy) return;
    setBusy(true);
    const done = await onSubmit(draft.title.trim(), schedule);
    setBusy(false);
    if (done && onCancel === undefined) setDraft(current => ({...current, title: ''}));
  };

  return (
    <form className="tickler-form" onSubmit={send}>
      <input
        className="tickler-title"
        value={draft.title}
        placeholder="What should come back? e.g. Pay the water bill"
        aria-label="Title"
        onChange={event => set('title', event.target.value)}
        onKeyDown={event => {
          if (event.key === 'Escape' && onCancel !== undefined) {
            event.stopPropagation();
            onCancel();
          }
        }}
      />
      <div className="tickler-schedule">
        <select value={draft.kind} aria-label="Repeats" onChange={event => set('kind', event.target.value as Kind)}>
          <option value="weekly">every week on</option>
          <option value="monthly">every month on the</option>
          <option value="once">once, on</option>
        </select>
        {draft.kind === 'weekly' && (
          <select value={draft.weekday} aria-label="Weekday" onChange={event => set('weekday', Number(event.target.value))}>
            {WEEKDAYS.map((name, index) => (
              <option key={name} value={index}>
                {name}
              </option>
            ))}
          </select>
        )}
        {draft.kind === 'monthly' && (
          <select value={draft.day} aria-label="Day of the month" onChange={event => set('day', Number(event.target.value))}>
            {Array.from({length: 31}, (_, index) => index + 1).map(day => (
              <option key={day} value={day}>
                {day}
              </option>
            ))}
          </select>
        )}
        {draft.kind === 'once' && (
          <input type="date" value={draft.date} aria-label="Date" onChange={event => set('date', event.target.value)} />
        )}
        <button className="primary" type="submit" disabled={!valid || busy}>
          {submit}
        </button>
        {onCancel !== undefined && (
          <button type="button" className="quiet" onClick={onCancel}>
            Cancel
          </button>
        )}
      </div>
      {valid && (
        <p className="muted small">
          {firstOn(schedule, today) <= today ? 'Goes into next today' : `First one ${shortDay(firstOn(schedule, today))}`}
          {draft.kind === 'monthly' && draft.day > 28 && ' · shorter months use their last day'}
        </p>
      )}
    </form>
  );
}

export function TicklerView({
  now,
  revision,
  toast,
  onChanged,
}: {
  now: string;
  revision: number;
  toast: (text: string, tone?: 'info' | 'error') => void;
  onChanged: () => void;
}) {
  const [items, setItems] = useState<TicklerJson[]>();
  const [editing, setEditing] = useState<string>();
  const [deleting, setDeleting] = useState<TicklerJson>();
  const today = localDate(now);

  const load = useCallback(() => {
    api.ticklers().then(setItems, () => setItems([]));
  }, []);
  useEffect(load, [load, revision]);

  const fail = (error: unknown) => toast(error instanceof Error ? error.message : String(error), 'error');

  const add = async (title: string, schedule: Schedule) => {
    try {
      const {fired} = await api.createTickler(title, schedule);
      toast(fired ? `"${title}" is due today, so it is already in next` : `Added "${title}" (${describeSchedule(schedule)})`);
      load();
      onChanged();
      return true;
    } catch (error) {
      fail(error);
      return false;
    }
  };

  const save = async (item: TicklerJson, title: string, schedule: Schedule) => {
    try {
      const same = JSON.stringify(schedule) === JSON.stringify(item.schedule);
      await api.patchTickler(item.id, item.version, {...(title === item.title ? {} : {title}), ...(same ? {} : {schedule})});
      setEditing(undefined);
      load();
      onChanged();
      return true;
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) {
        toast('Someone else changed it first; here it is as it is now.', 'error');
        load();
      } else fail(error);
      return false;
    }
  };

  const remove = async (item: TicklerJson) => {
    setDeleting(undefined);
    try {
      await api.removeTickler(item.id);
      toast(`Deleted "${item.title}"`);
      load();
    } catch (error) {
      fail(error);
    }
  };

  return (
    <>
      <div className="list-head">
        <div>
          <h1>Tickler</h1>
          <p className="muted">Things that come back. Each one lands in next, tagged #tickler, on its day.</p>
        </div>
      </div>

      <TicklerForm initial={draftFrom('', {kind: 'weekly', weekday: new Date(`${today}T12:00:00`).getDay()}, today)} submit="Add" today={today} onSubmit={add} />

      {items === undefined ? null : items.length === 0 ? (
        <p className="empty">Nothing in the tickler yet. Bills, check-ins, renewals: anything you would otherwise have to remember.</p>
      ) : (
        <ul className="rows ticklers">
          {items.map(item =>
            editing === item.id ? (
              <li key={item.id} className="row tickler-editing">
                <TicklerForm
                  initial={draftFrom(item.title, item.schedule, today)}
                  submit="Save"
                  today={today}
                  onSubmit={(title, schedule) => save(item, title, schedule)}
                  onCancel={() => setEditing(undefined)}
                />
              </li>
            ) : (
              <li key={item.id} className="row tickler-row" onClick={() => setEditing(item.id)} title="Edit">
                <span className="row-title">{item.title}</span>
                <span className="row-meta">
                  <span className="meta">{item.description}</span>
                  <span className="meta">{item.schedule.kind === 'once' ? '' : `next ${shortDay(item.next_on)}`}</span>
                  <button
                    className="quiet small"
                    onClick={event => {
                      event.stopPropagation();
                      setDeleting(item);
                    }}
                  >
                    Delete
                  </button>
                </span>
              </li>
            ),
          )}
        </ul>
      )}

      {deleting !== undefined && (
        <Confirm
          title={`Delete "${deleting.title}"?`}
          message="It stops coming back. A task it already put in next stays there. There is no undo."
          confirm="Delete"
          onConfirm={() => void remove(deleting)}
          onClose={() => setDeleting(undefined)}
        />
      )}
    </>
  );
}
