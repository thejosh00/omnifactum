/**
 * One task, in full: its fields, its notes, its log, and what you can do with it.
 *
 * Editing a field is a replacement, so it is sent with the version it was based on. If
 * the task has moved on since, the server refuses, and this checks whether the field
 * you touched is actually the one that changed. Usually it is not — an agent added a
 * log line, or tagged it — and the edit is re-sent against the new version without
 * bothering you. Only a real clash, someone else rewriting the same field, asks you
 * which to keep.
 */
import {useCallback, useEffect, useState, type ReactNode} from 'react';
import {formatDue, timeAgo} from '../core/format.ts';
import {api, ApiError, type TaskJson} from './api.ts';

type Field = 'title' | 'body' | 'due' | 'defer' | 'waiting_on' | 'project';

interface Clash {
  field: Field;
  mine: string;
  theirs: TaskJson;
}

export interface DetailActions {
  complete: (task: TaskJson) => void;
  sendBack: (task: TaskJson) => void;
  move: (task: TaskJson) => void;
  note: (task: TaskJson) => void;
  tags: (task: TaskJson) => void;
  remove: (task: TaskJson) => void;
  clarify: (task: TaskJson) => void;
  fail: (message: string) => void;
}

function valueOf(task: TaskJson, field: Field): string {
  return (task[field] as string | undefined) ?? '';
}

function Actor({actor}: {actor: string}) {
  const agent = actor.startsWith('agent:');
  return <span className={agent ? 'actor agent' : 'actor'}>{actor || 'someone'}</span>;
}

/** An input that saves on blur or Enter, and shows the stored value otherwise. */
function FieldInput({
  label,
  value,
  type = 'text',
  placeholder,
  action,
  onSave,
}: {
  label: string;
  value: string;
  type?: 'text' | 'date';
  placeholder?: string;
  /** Something to do with the value, shown beside the label. */
  action?: ReactNode;
  onSave: (value: string) => void;
}) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const commit = () => {
    if (draft.trim() !== value) onSave(draft.trim());
  };
  return (
    <label className="field">
      <span>
        {label}
        {action}
      </span>
      <input
        type={type}
        value={type === 'date' ? draft.slice(0, 10) : draft}
        placeholder={placeholder}
        onChange={event => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={event => {
          if (event.key === 'Enter') (event.target as HTMLInputElement).blur();
          if (event.key === 'Escape') {
            setDraft(value);
            event.stopPropagation();
          }
        }}
      />
    </label>
  );
}

export function Detail({
  id,
  revision,
  now,
  actions,
  onClose,
  onChanged,
  onOpenProject,
}: {
  id: string;
  /** Bumped whenever the list hears this task changed elsewhere. */
  revision: number;
  now: string;
  actions: DetailActions;
  onClose: () => void;
  onChanged: () => void;
  /** Open the project a task belongs to, by the stem the task stores. */
  onOpenProject: (ref: string) => void;
}) {
  const [task, setTask] = useState<TaskJson>();
  const [missing, setMissing] = useState(false);
  const [body, setBody] = useState('');
  const [bodyBase, setBodyBase] = useState<{text: string; version: number}>();
  const [clash, setClash] = useState<Clash>();

  const dirty = bodyBase !== undefined && body !== bodyBase.text;

  const adopt = useCallback((next: TaskJson, keepDraft: boolean) => {
    setTask(next);
    if (!keepDraft) {
      setBody(next.body);
      setBodyBase({text: next.body, version: next.version});
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    api.show(id).then(
      next => {
        if (cancelled) return;
        setMissing(false);
        // A draft you are typing is never replaced under you.
        adopt(next, dirty);
      },
      error => {
        if (!cancelled && error instanceof ApiError && error.status === 404) setMissing(true);
      },
    );
    return () => {
      cancelled = true;
    };
    // `dirty` is read, not reacted to: only a new id or revision refetches.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, revision, adopt]);

  const save = useCallback(
    async (field: Field, value: string, base: TaskJson) => {
      const send = (version: number) => api.patch(id, version, {[field]: value.length === 0 ? null : value});
      try {
        adopt(await send(base.version), false);
        onChanged();
      } catch (error) {
        const theirs = error instanceof ApiError ? error.current : undefined;
        if (theirs === undefined) {
          actions.fail(error instanceof Error ? error.message : String(error));
          return;
        }
        if (valueOf(theirs, field) === valueOf(base, field)) {
          // Someone changed something else. Yours still applies cleanly.
          try {
            adopt(await send(theirs.version), false);
            onChanged();
          } catch (retry) {
            actions.fail(retry instanceof Error ? retry.message : String(retry));
          }
          return;
        }
        setTask(theirs);
        setClash({field, mine: value, theirs});
      }
    },
    [id, adopt, onChanged, actions],
  );

  if (missing) {
    return (
      <aside className="detail">
        <header className="detail-head">
          <button className="icon" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </header>
        <p className="empty">This task was deleted.</p>
      </aside>
    );
  }
  if (task === undefined) return <aside className="detail" aria-busy="true" />;

  const baseForBody: TaskJson = bodyBase === undefined ? task : {...task, body: bodyBase.text, version: bodyBase.version};
  const inReview = task.state === 'review';

  return (
    <aside className="detail" aria-label={task.title}>
      <header className="detail-head">
        <span className={`state-pill state-${task.state}`}>{task.state}</span>
        <span className="muted">
          {task.stem} · v{task.version}
        </span>
        <button className="icon" onClick={onClose} aria-label="Close">
          ✕
        </button>
      </header>

      {clash !== undefined && (
        <div className="clash" role="alert">
          <p>
            <strong>Someone else changed the {clash.field.replace('_', ' ')}</strong> while you were editing it.
          </p>
          <div className="clash-actions">
            <button
              className="primary"
              onClick={() => {
                const {field, mine, theirs} = clash;
                setClash(undefined);
                void save(field, mine, theirs);
              }}
            >
              Keep mine
            </button>
            <button
              className="quiet"
              onClick={() => {
                adopt(clash.theirs, false);
                setClash(undefined);
              }}
            >
              Use theirs
            </button>
          </div>
        </div>
      )}

      <input
        className="detail-title"
        key={`${task.id}-${task.title}`}
        defaultValue={task.title}
        aria-label="Title"
        onBlur={event => {
          const value = event.target.value.trim();
          if (value.length > 0 && value !== task.title) void save('title', value, task);
          else event.target.value = task.title;
        }}
        onKeyDown={event => {
          if (event.key === 'Enter') (event.target as HTMLInputElement).blur();
        }}
      />

      <div className="detail-actions">
        {inReview ? (
          <>
            <button className="primary" onClick={() => actions.complete(task)}>
              Accept <kbd>x</kbd>
            </button>
            <button onClick={() => actions.sendBack(task)}>Send back…</button>
          </>
        ) : task.state === 'inbox' ? (
          <button className="primary" onClick={() => actions.clarify(task)}>
            Clarify <kbd>C</kbd>
          </button>
        ) : task.state !== 'done' ? (
          <button className="primary" onClick={() => actions.complete(task)}>
            Complete <kbd>x</kbd>
          </button>
        ) : null}
        <button onClick={() => actions.move(task)}>
          Move <kbd>m</kbd>
        </button>
        <button onClick={() => actions.note(task)}>
          Note <kbd>N</kbd>
        </button>
        <button onClick={() => actions.tags(task)}>
          Tags <kbd>t</kbd>
        </button>
        <button className="danger-quiet" onClick={() => actions.remove(task)}>
          Delete
        </button>
      </div>

      <div className="tags-row">
        {task.tags.length === 0 ? (
          <span className="muted">no tags</span>
        ) : (
          task.tags.map(tag => (
            <span key={tag} className="tag">
              #{tag}
            </span>
          ))
        )}
      </div>

      <div className="fields">
        <FieldInput label="Due" type="date" value={task.due ?? ''} onSave={value => void save('due', value, task)} />
        {task.state === 'someday' && (
          <FieldInput label="Defer until" type="date" value={task.defer ?? ''} onSave={value => void save('defer', value, task)} />
        )}
        {task.state === 'waiting' && (
          <FieldInput
            label="Waiting on"
            value={task.waiting_on ?? ''}
            placeholder="who"
            onSave={value => void save('waiting_on', value, task)}
          />
        )}
        <FieldInput
          label="Project"
          value={task.project ?? ''}
          placeholder="none"
          action={
            task.project !== undefined && (
              <button className="link field-action" onClick={() => onOpenProject(task.project!)}>
                open →
              </button>
            )
          }
          onSave={value => void save('project', value, task)}
        />
      </div>
      {task.due !== undefined && (
        <p className={`due due-${formatDue(task.due, now).urgency}`}>{formatDue(task.due, now).text}</p>
      )}

      <section className="notes">
        <h3>Notes</h3>
        <textarea
          value={body}
          placeholder="Anything worth knowing. Markdown is fine."
          rows={Math.min(16, Math.max(4, body.split('\n').length + 1))}
          onChange={event => setBody(event.target.value)}
          onKeyDown={event => {
            if (event.key === 'Escape') {
              (event.target as HTMLTextAreaElement).blur();
              event.stopPropagation();
            }
            if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && dirty) {
              void save('body', body, baseForBody);
            }
          }}
        />
        {dirty && (
          <div className="notes-actions">
            <button className="primary" onClick={() => void save('body', body, baseForBody)}>
              Save notes
            </button>
            <button className="quiet" onClick={() => setBody(bodyBase?.text ?? task.body)}>
              Discard
            </button>
            {task.version !== bodyBase?.version && <span className="muted">This task changed while you typed.</span>}
          </div>
        )}
      </section>

      <section className="log">
        <h3>Log</h3>
        {task.log.length === 0 ? (
          <p className="muted">Nothing yet.</p>
        ) : (
          <ol>
            {[...task.log].reverse().map((entry, index) => (
              <li key={`${entry.at}-${index}`}>
                <div className="log-meta">
                  <Actor actor={entry.actor} />
                  <time dateTime={entry.at} title={entry.at}>
                    {entry.at === '' ? '' : timeAgo(entry.at, now)}
                  </time>
                </div>
                <p>{entry.text}</p>
              </li>
            ))}
          </ol>
        )}
      </section>

      <p className="muted small">Created {timeAgo(task.created, now)}</p>
    </aside>
  );
}
