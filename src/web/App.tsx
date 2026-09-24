/**
 * The web app: pick an account, then work your lists.
 *
 * The list is always what the server says it is. Every action is sent as an intention
 * — complete this, move that, add this tag — and then the list is fetched again, and it
 * is fetched again whenever the event stream says someone else changed something. There
 * is no client-side copy to drift, which matters because agents are changing the same
 * tasks while you look at them.
 */
import {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {applyTagEdit, formatTags, parseCapture, parseTagEdit} from '../core/capture.ts';
import {describeChange, type Change} from '../core/diff.ts';
import {metaSegments} from '../core/format.ts';
import {TASK_STATES, type TaskState} from '../core/types.ts';
import {api, ApiError, listen, type AccountInfo, type ChangeEvent, type Session, type TaskJson, type TaskList} from './api.ts';
import {Detail, type DetailActions} from './Detail.tsx';
import {Confirm, Help, MoveMenu, Prompt, type PromptRequest} from './Dialogs.tsx';
import {intentFor, type Intent} from './keys.ts';

const LIST_BLURBS: Record<TaskState, string> = {
  inbox: 'Captured, not yet thought about',
  next: 'What you can do now',
  waiting: 'What others owe you',
  someday: 'Not now, maybe later',
  review: 'Finished work waiting for you to check',
  done: 'Finished',
};

const EMPTY: Record<TaskState, string> = {
  inbox: 'Inbox zero.',
  next: 'No next actions.',
  waiting: 'Not waiting on anything.',
  someday: 'Nothing on the someday list.',
  review: 'Nothing waiting to be checked.',
  done: 'Nothing completed yet.',
};

function useNow(): string {
  const [now, setNow] = useState(() => new Date().toISOString());
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date().toISOString()), 60_000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

function listFromHash(): TaskState {
  const name = window.location.hash.replace(/^#\/?/, '');
  return (TASK_STATES as readonly string[]).includes(name) ? (name as TaskState) : 'next';
}

function isTyping(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName);
}

// --- signing in --------------------------------------------------------------------

function Login({onSignedIn}: {onSignedIn: () => void}) {
  const [accounts, setAccounts] = useState<AccountInfo[]>();
  const [chosen, setChosen] = useState<AccountInfo>();
  const [pin, setPin] = useState('');
  const [error, setError] = useState<string>();

  useEffect(() => {
    api.accounts().then(setAccounts, () => setError('Cannot reach the server.'));
  }, []);

  const signIn = async (account: AccountInfo, withPin?: string) => {
    try {
      await api.login(account.name, withPin);
      onSignedIn();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    }
  };

  return (
    <main className="login">
      <h1 className="wordmark">omnifactum</h1>
      <p className="muted">Which lists?</p>
      <div className="accounts">
        {accounts?.map(account => (
          <button
            key={account.name}
            className={chosen?.name === account.name ? 'account chosen' : 'account'}
            onClick={() => {
              setError(undefined);
              if (account.has_pin) setChosen(account);
              else void signIn(account);
            }}
          >
            {account.name}
          </button>
        ))}
      </div>
      {chosen !== undefined && (
        <form
          className="pin"
          onSubmit={event => {
            event.preventDefault();
            void signIn(chosen, pin);
          }}
        >
          <input
            autoFocus
            type="password"
            inputMode="numeric"
            placeholder={`PIN for ${chosen.name}`}
            value={pin}
            onChange={event => setPin(event.target.value)}
          />
          <button className="primary">Open</button>
        </form>
      )}
      {error !== undefined && <p className="field-error">{error}</p>}
    </main>
  );
}

// --- the workspace -----------------------------------------------------------------

interface Toast {
  id: number;
  text: string;
  tone: 'info' | 'error';
}

type Dialog =
  | {kind: 'prompt'; request: PromptRequest}
  | {kind: 'move'; task: TaskJson}
  | {kind: 'delete'; task: TaskJson}
  | {kind: 'help'};

function Row({
  task,
  selected,
  list,
  now,
  onSelect,
  onOpen,
}: {
  task: TaskJson;
  selected: boolean;
  list: TaskState;
  now: string;
  onSelect: () => void;
  onOpen: () => void;
}) {
  const ref = useRef<HTMLLIElement>(null);
  useEffect(() => {
    if (selected) ref.current?.scrollIntoView({block: 'nearest'});
  }, [selected]);

  const latest = task.log.at(-1);
  const segments = metaSegments(
    {
      tags: task.tags,
      project: task.project,
      due: task.due,
      defer: task.defer,
      waitingOn: task.waiting_on,
      submitted: list === 'review' && latest !== undefined ? {actor: latest.actor, at: latest.at} : undefined,
    },
    now,
    {deferred: list === 'someday'},
  );

  return (
    <li
      ref={ref}
      className={selected ? 'row selected' : 'row'}
      aria-selected={selected}
      onMouseDown={onSelect}
      onClick={onOpen}
    >
      <span className="row-title">{task.title}</span>
      <span className="row-meta">
        {segments.map((segment, index) => (
          <span
            key={index}
            className={`meta meta-${segment.kind}${segment.urgency === undefined ? '' : ` due-${segment.urgency}`}${
              segment.actor?.startsWith('agent:') === true ? ' agent' : ''
            }`}
          >
            {segment.text}
          </span>
        ))}
      </span>
      {list === 'review' && latest !== undefined && <span className="row-note">{latest.text}</span>}
    </li>
  );
}

function Workspace({session, onSignedOut}: {session: Session; onSignedOut: () => void}) {
  const now = useNow();
  const [list, setList] = useState<TaskState>(listFromHash);
  const [query, setQuery] = useState('');
  const [data, setData] = useState<TaskList>();
  const [cursor, setCursor] = useState<string>();
  const [open, setOpen] = useState<string>();
  const [revision, setRevision] = useState(0);
  const [dialog, setDialog] = useState<Dialog>();
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [capture, setCapture] = useState('');
  const captureInput = useRef<HTMLInputElement>(null);
  const filterInput = useRef<HTMLInputElement>(null);
  const openRef = useRef(open);
  openRef.current = open;

  const toast = useCallback((text: string, tone: Toast['tone'] = 'info') => {
    const id = Date.now() + Math.random();
    setToasts(current => [...current.slice(-3), {id, text, tone}]);
    setTimeout(() => setToasts(current => current.filter(item => item.id !== id)), tone === 'error' ? 8000 : 5000);
  }, []);

  const reload = useCallback(async () => {
    try {
      const next = await api.list(list, query);
      setData(next);
    } catch (failure) {
      if (failure instanceof ApiError && failure.status === 401) onSignedOut();
      else toast(failure instanceof Error ? failure.message : String(failure), 'error');
    }
  }, [list, query, toast, onSignedOut]);

  useEffect(() => {
    void reload();
  }, [reload]);

  useEffect(() => {
    window.location.hash = `/${list}`;
    setCursor(undefined);
  }, [list]);

  // Changes made elsewhere: refetch, and say what happened if it was not you.
  const reloadRef = useRef(reload);
  reloadRef.current = reload;
  useEffect(() => {
    let pending: ReturnType<typeof setTimeout> | undefined;
    const soon = () => {
      clearTimeout(pending);
      pending = setTimeout(() => void reloadRef.current(), 120);
    };
    return listen(
      (event: ChangeEvent) => {
        soon();
        if (event.id === openRef.current) setRevision(value => value + 1);
        if (event.actor !== undefined && event.actor !== session.actor) {
          const change: Change = event;
          toast(describeChange(change) + (event.note === undefined ? '' : `: ${event.note}`));
        }
      },
      soon,
    );
  }, [session.actor, toast]);

  const rows = data?.tasks ?? [];
  const index = Math.max(
    0,
    rows.findIndex(task => task.id === cursor),
  );
  const selected: TaskJson | undefined = rows[index];

  // Keep the cursor on a real row as the list changes underneath it.
  useEffect(() => {
    if (rows.length > 0 && !rows.some(task => task.id === cursor)) {
      setCursor(rows[Math.min(index, rows.length - 1)]?.id);
    }
  }, [rows, cursor, index]);

  /** Run an action, then refresh; report a failure rather than swallow it. */
  const act = useCallback(
    async (run: () => Promise<unknown>, done?: string) => {
      try {
        await run();
        if (done !== undefined) toast(done);
      } catch (failure) {
        toast(failure instanceof Error ? failure.message : String(failure), 'error');
      }
      await reload();
      setRevision(value => value + 1);
    },
    [reload, toast],
  );

  const actions: DetailActions = useMemo(
    () => ({
      complete: task => {
        if (task.state === 'review') {
          void act(() => api.done(task.id), `Accepted "${task.title}"`);
          return;
        }
        setDialog({
          kind: 'prompt',
          request: {
            title: `Complete "${task.title}"`,
            label: 'What did you do? (optional)',
            submit: 'Complete',
            onSubmit: note => void act(() => api.done(task.id, note || undefined), `Completed "${task.title}"`),
          },
        });
      },
      sendBack: task =>
        setDialog({
          kind: 'prompt',
          request: {
            title: `Send "${task.title}" back`,
            label: 'What still needs doing? Whoever picks it up next reads this.',
            required: 'Say why, so it can be fixed.',
            submit: 'Send back to next',
            onSubmit: note => void act(() => api.move(task.id, 'next', note), `Sent back "${task.title}"`),
          },
        }),
      move: task => setDialog({kind: 'move', task}),
      note: task =>
        setDialog({
          kind: 'prompt',
          request: {
            title: 'Record what happened',
            placeholder: 'The supplier called back…',
            required: 'A note needs some text.',
            submit: 'Add to log',
            onSubmit: note => void act(() => api.note(task.id, note)),
          },
        }),
      tags: task =>
        setDialog({
          kind: 'prompt',
          request: {
            title: 'Tags',
            label: 'Space-separated. -tag removes one.',
            initial: formatTags(task.tags),
            submit: 'Save tags',
            onSubmit: line => {
              // Sent as additions and removals, so a tag an agent added meanwhile stays.
              const wanted = applyTagEdit(task.tags, parseTagEdit(line));
              const add = wanted.filter(tag => !task.tags.includes(tag));
              const remove = task.tags.filter(tag => !wanted.includes(tag));
              if (add.length > 0 || remove.length > 0) void act(() => api.tags(task.id, add, remove));
            },
          },
        }),
      remove: task => setDialog({kind: 'delete', task}),
      fail: message => toast(message, 'error'),
    }),
    [act, toast],
  );

  const moveTo = (task: TaskJson, to: TaskState) => {
    if (task.state === 'review' && to === 'next') {
      actions.sendBack(task);
      return;
    }
    if (to === 'done') {
      actions.complete(task);
      return;
    }
    void act(() => api.move(task.id, to), `Moved to ${to}`);
  };

  const submitCapture = () => {
    const captured = parseCapture(capture);
    if (captured.title.length === 0) return;
    setCapture('');
    void act(
      () =>
        api.create({
          title: captured.title,
          state: 'inbox',
          tags: captured.tags,
          ...(captured.project === undefined ? {} : {project: captured.project}),
        }),
      list === 'inbox' ? undefined : `Captured "${captured.title}" to the inbox`,
    );
  };

  const run = useCallback(
    (intent: Intent) => {
      if (intent.startsWith('list:')) {
        setList(intent.slice(5) as TaskState);
        return;
      }
      switch (intent) {
        case 'down':
          setCursor(rows[Math.min(rows.length - 1, index + 1)]?.id);
          return;
        case 'up':
          setCursor(rows[Math.max(0, index - 1)]?.id);
          return;
        case 'top':
          setCursor(rows[0]?.id);
          return;
        case 'bottom':
          setCursor(rows.at(-1)?.id);
          return;
        case 'open':
          if (selected !== undefined) setOpen(selected.id);
          return;
        case 'close':
          if (open !== undefined) setOpen(undefined);
          else if (query.length > 0) setQuery('');
          return;
        case 'capture':
          captureInput.current?.focus();
          return;
        case 'filter':
          filterInput.current?.focus();
          return;
        case 'help':
          setDialog({kind: 'help'});
          return;
      }
      const target = open === undefined ? selected : (rows.find(task => task.id === open) ?? selected);
      if (target === undefined) return;
      switch (intent) {
        case 'complete':
          actions.complete(target);
          return;
        case 'move':
          actions.move(target);
          return;
        case 'note':
          actions.note(target);
          return;
        case 'tags':
          actions.tags(target);
          return;
        case 'delete':
          actions.remove(target);
          return;
      }
    },
    [rows, index, selected, open, query, actions],
  );

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (dialog !== undefined) return;
      if (isTyping(event.target)) {
        if (event.key === 'Escape') (event.target as HTMLElement).blur();
        return;
      }
      const intent = intentFor(event);
      if (intent === undefined) return;
      event.preventDefault();
      run(intent);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [run, dialog]);

  const switchAccount = async (name: string) => {
    if (name === session.account) return;
    const account = session.accounts.find(item => item.name === name);
    if (account?.has_pin === true) {
      setDialog({
        kind: 'prompt',
        request: {
          title: `Open ${name}`,
          label: 'PIN',
          required: 'This account asks for a PIN.',
          submit: 'Open',
          onSubmit: pin =>
            void api.login(name, pin).then(
              () => window.location.reload(),
              failure => toast(String(failure.message ?? failure), 'error'),
            ),
        },
      });
      return;
    }
    await api.login(name);
    window.location.reload();
  };

  return (
    <div className={open === undefined ? 'app' : 'app with-detail'}>
      <header className="topbar">
        <span className="wordmark small">omnifactum</span>
        <select
          className="account-switch"
          value={session.account}
          aria-label="Account"
          onChange={event => void switchAccount(event.target.value)}
        >
          {session.accounts.map(account => (
            <option key={account.name} value={account.name}>
              {account.name}
            </option>
          ))}
        </select>
        <form
          className="capture"
          onSubmit={event => {
            event.preventDefault();
            submitCapture();
          }}
        >
          <input
            ref={captureInput}
            value={capture}
            placeholder="Capture…  #tag +project   (c)"
            aria-label="Capture a task"
            onChange={event => setCapture(event.target.value)}
          />
        </form>
        <button className="icon" onClick={() => setDialog({kind: 'help'})} aria-label="Keyboard help">
          ?
        </button>
        <button
          className="quiet small"
          onClick={() => void api.logout().then(onSignedOut)}
          title="Sign out of this browser"
        >
          Sign out
        </button>
      </header>

      <nav className="tabs" aria-label="Lists">
        {TASK_STATES.map((state, position) => (
          <button
            key={state}
            className={state === list ? 'tab active' : 'tab'}
            onClick={() => setList(state)}
            aria-current={state === list ? 'page' : undefined}
            title={`${LIST_BLURBS[state]} (${position + 1})`}
          >
            {state}
            {state !== 'done' && (data?.counts[state] ?? 0) > 0 && (
              <span className={state === 'review' ? 'count attention' : 'count'}>{data?.counts[state]}</span>
            )}
          </button>
        ))}
      </nav>

      <main className="list-pane">
        <div className="list-head">
          <div>
            <h1>{list}</h1>
            <p className="muted">{LIST_BLURBS[list]}</p>
          </div>
          <input
            ref={filterInput}
            className="filter"
            type="search"
            value={query}
            placeholder="Filter  (/)"
            aria-label="Filter"
            onChange={event => setQuery(event.target.value)}
          />
        </div>
        {data?.warnings.map(warning => (
          <p key={warning} className="field-error">
            {warning}
          </p>
        ))}
        {data === undefined ? null : rows.length === 0 ? (
          <p className="empty">{query.length > 0 ? 'Nothing matches.' : EMPTY[list]}</p>
        ) : (
          <ul className="rows" role="listbox" aria-label={list}>
            {rows.map(task => (
              <Row
                key={task.id}
                task={task}
                list={list}
                now={now}
                selected={task.id === selected?.id}
                onSelect={() => setCursor(task.id)}
                onOpen={() => setOpen(task.id)}
              />
            ))}
          </ul>
        )}
      </main>

      {open !== undefined && (
        <Detail
          key={open}
          id={open}
          revision={revision}
          now={now}
          actions={actions}
          onClose={() => setOpen(undefined)}
          onChanged={() => void reload()}
        />
      )}

      <div className="toasts" aria-live="polite">
        {toasts.map(item => (
          <div key={item.id} className={`toast toast-${item.tone}`}>
            {item.text}
          </div>
        ))}
      </div>

      {dialog?.kind === 'prompt' && <Prompt request={dialog.request} onClose={() => setDialog(undefined)} />}
      {dialog?.kind === 'move' && (
        <MoveMenu from={dialog.task.state as TaskState} onMove={to => moveTo(dialog.task, to)} onClose={() => setDialog(undefined)} />
      )}
      {dialog?.kind === 'delete' && (
        <Confirm
          title="Delete permanently?"
          message={`"${dialog.task.title}" will be gone for good. There is no trash and no undo.${
            dialog.task.state === 'done' ? '' : ' Moving it to someday keeps it out of the way instead.'
          }`}
          confirm="Delete"
          onConfirm={() => {
            if (open === dialog.task.id) setOpen(undefined);
            void act(() => api.remove(dialog.task.id), `Deleted "${dialog.task.title}"`);
          }}
          onClose={() => setDialog(undefined)}
        />
      )}
      {dialog?.kind === 'help' && <Help onClose={() => setDialog(undefined)} />}
    </div>
  );
}

export function App() {
  const [session, setSession] = useState<Session | null>();

  const check = useCallback(() => {
    api.session().then(setSession, () => setSession(null));
  }, []);
  useEffect(check, [check]);

  if (session === undefined) return null;
  if (session === null) return <Login onSignedIn={check} />;
  return <Workspace session={session} onSignedOut={() => setSession(null)} />;
}
