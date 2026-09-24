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
import {formatDue, metaSegments, shortDate} from '../core/format.ts';
import {TASK_STATES, type TaskState} from '../core/types.ts';
import {
  api,
  ApiError,
  listen,
  type AccountInfo,
  type ChangeEvent,
  type Session,
  type TaskJson,
  type TaskList,
  type WeeklyPlan,
} from './api.ts';
import {Clarify} from './Clarify.tsx';
import {captureSuggest, CompletingInput, tagSuggest, useVocabulary} from './Complete.tsx';
import {NewProjectDialog, ProjectPanel, ProjectsView} from './Projects.tsx';
import {TicklerView} from './Ticklers.tsx';
import {WeeklyBanner} from './Weekly.tsx';
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
  | {kind: 'help'}
  | {kind: 'clarify'; ids: string[]; walking: boolean}
  | {kind: 'new-project'};

type Page = 'lists' | 'projects' | 'tickler';

/** Keys that act on the task list, which mean nothing on the projects page. */
const TASK_LIST_INTENTS = new Set<Intent>(['down', 'up', 'top', 'bottom', 'open', 'complete', 'move', 'note', 'tags', 'delete', 'clarify']);

function Row({
  task,
  selected,
  list,
  now,
  onSelect,
  onOpen,
  onOpenProject,
}: {
  task: TaskJson;
  selected: boolean;
  list: TaskState;
  now: string;
  onSelect: () => void;
  onOpen: () => void;
  onOpenProject: (ref: string) => void;
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
        {segments.map((segment, index) =>
          segment.kind === 'project' && task.project !== undefined ? (
            <button
              key={index}
              className="link meta meta-project"
              title="Open the project"
              onClick={event => {
                event.stopPropagation();
                onOpenProject(task.project!);
              }}
            >
              {segment.text}
            </button>
          ) : (
            <span
              key={index}
              className={`meta meta-${segment.kind}${segment.urgency === undefined ? '' : ` due-${segment.urgency}`}${
                segment.actor?.startsWith('agent:') === true ? ' agent' : ''
              }`}
            >
              {segment.text}
            </span>
          ),
        )}
      </span>
      {list === 'review' && latest !== undefined && <span className="row-note">{latest.text}</span>}
    </li>
  );
}

/** How the capture line will be read, shown while you type it, so nothing is a surprise. */
function CapturePreview({line, now}: {line: string; now: string}) {
  const captured = parseCapture(line, now);
  const bits: string[] = [`→ ${captured.state ?? 'inbox'}`];
  if (captured.waitingOn !== undefined) bits.push(`on ${captured.waitingOn}`);
  if (captured.due !== undefined) bits.push(`due ${formatDue(captured.due, now).text.replace(/^due /, '')} (${shortDate(captured.due)})`);
  if (captured.defer !== undefined) bits.push(`hidden until ${shortDate(captured.defer)}`);
  if (captured.project !== undefined) bits.push(`+${captured.project}`);
  for (const tag of captured.tags) bits.push(`#${tag}`);

  return (
    <div className="capture-preview" aria-live="polite">
      {captured.problems === undefined ? (
        <span>
          <strong>{captured.title}</strong> <span className="muted">{bits.join(' · ')}</span>
        </span>
      ) : (
        <span className="field-error">{captured.problems.join(' · ')}</span>
      )}
    </div>
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
  const [captureFocused, setCaptureFocused] = useState(false);
  const [weekly, setWeekly] = useState<WeeklyPlan>();
  const [walk, setWalk] = useState<{index: number; recorded?: number}>();
  // Which page the list pane shows: the task lists, or one of the pages beside them.
  const [page, setPage] = useState<Page>(() => {
    const hash = window.location.hash.replace(/^#\/?/, '');
    return hash === 'projects' || hash === 'tickler' ? hash : 'lists';
  });
  const projectsView = page === 'projects';
  const ticklerView = page === 'tickler';
  const [openProject, setOpenProject] = useState<string>();
  const openProjectRef = useRef(openProject);
  openProjectRef.current = openProject;

  // One panel at a time on the right: a task, or a project.
  const openTask = useCallback((id: string) => {
    setOpenProject(undefined);
    setOpen(id);
  }, []);
  const openProjectPanel = useCallback((id: string) => {
    setOpen(undefined);
    setOpenProject(id);
  }, []);
  const showList = useCallback((state: TaskState) => {
    setPage('lists');
    setList(state);
  }, []);
  const captureInput = useRef<HTMLInputElement>(null);
  const filterInput = useRef<HTMLInputElement>(null);
  const openRef = useRef(open);
  openRef.current = open;

  const toast = useCallback((text: string, tone: Toast['tone'] = 'info') => {
    const id = Date.now() + Math.random();
    setToasts(current => [...current.slice(-3), {id, text, tone}]);
    setTimeout(() => setToasts(current => current.filter(item => item.id !== id)), tone === 'error' ? 8000 : 5000);
  }, []);

  const vocabulary = useVocabulary(revision);
  const captureSuggestions = useMemo(() => captureSuggest(vocabulary, now), [vocabulary, now]);
  const tagSuggestions = useMemo(() => tagSuggest(vocabulary), [vocabulary]);

  const reload = useCallback(async () => {
    try {
      // The review plan is re-read with the list, so a step you have just cleared says so.
      const [next, plan] = await Promise.all([api.list(list, query), api.weekly()]);
      setData(next);
      setWeekly(plan);
    } catch (failure) {
      if (failure instanceof ApiError && failure.status === 401) onSignedOut();
      else toast(failure instanceof Error ? failure.message : String(failure), 'error');
    }
  }, [list, query, toast, onSignedOut]);

  useEffect(() => {
    void reload();
  }, [reload]);

  // Each step of the review shows its own list.
  const walkStep = walk === undefined || weekly === undefined ? undefined : weekly.steps[walk.index];
  useEffect(() => {
    if (walkStep?.list !== undefined) showList(walkStep.list);
  }, [walkStep?.step, walkStep?.list, showList]);
  const showingProjects = walk !== undefined && walk.recorded === undefined && walkStep !== undefined && walkStep.list === undefined;

  const stepTo = useCallback(
    (index: number) => {
      if (weekly === undefined) return;
      setWalk({index: Math.max(0, Math.min(weekly.steps.length - 1, index))});
    },
    [weekly],
  );

  const finishWeekly = useCallback(async () => {
    try {
      const result = await api.recordWeekly();
      setWalk(current => (current === undefined ? current : {...current, recorded: result.projects_stamped}));
      void reload();
    } catch (failure) {
      toast(failure instanceof Error ? failure.message : String(failure), 'error');
    }
  }, [reload, toast]);

  useEffect(() => {
    window.location.hash = page === 'lists' ? `/${list}` : `/${page}`;
    setCursor(undefined);
  }, [list, page]);

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
        // A project's panel lists its tasks, so any change may be one it shows.
        if (event.id === openRef.current || event.entity !== 'task' || openProjectRef.current !== undefined) {
          setRevision(value => value + 1);
        }
        // The tickler rescheduling itself is bookkeeping; the task it made is the news.
        const bookkeeping = event.entity === 'tickler' && event.actor === 'omni';
        if (event.actor !== undefined && event.actor !== session.actor && !bookkeeping) {
          const change = event as Change;
          const sentence = describeChange(change) + (event.note === undefined ? '' : `: ${event.note}`);
          toast(event.entity === 'project' ? `Project ${sentence}` : event.entity === 'tickler' ? `Tickler item ${sentence}` : sentence);
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
            suggest: tagSuggestions,
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
      clarify: task => setDialog({kind: 'clarify', ids: [task.id], walking: false}),
      fail: message => toast(message, 'error'),
    }),
    [act, toast, tagSuggestions],
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

  /** Walk the inbox from the cursor down, then round to the top. */
  const clarifyInbox = () => {
    if (list !== 'inbox' || rows.length === 0) return;
    const ids = rows.map(task => task.id);
    setDialog({kind: 'clarify', ids: [...ids.slice(index), ...ids.slice(0, index)], walking: true});
  };

  const submitCapture = () => {
    const captured = parseCapture(capture, new Date().toISOString());
    if (captured.problems !== undefined) {
      // The preview is already showing what is wrong; say it once more, and keep the line.
      toast(captured.problems[0]!, 'error');
      return;
    }
    if (captured.title.length === 0) return;
    const state = captured.state ?? 'inbox';
    setCapture('');
    void act(
      () =>
        api.create({
          title: captured.title,
          state,
          tags: captured.tags,
          ...(captured.project === undefined ? {} : {project: captured.project}),
          ...(captured.due === undefined ? {} : {due: captured.due}),
          ...(captured.defer === undefined ? {} : {defer: captured.defer}),
          ...(captured.waitingOn === undefined ? {} : {waiting_on: captured.waitingOn}),
        }),
      list === state && page === 'lists' ? undefined : `Captured "${captured.title}" to ${state}`,
    );
  };

  const run = useCallback(
    (intent: Intent) => {
      if (intent.startsWith('list:')) {
        showList(intent.slice(5) as TaskState);
        return;
      }
      if (page !== 'lists' && open === undefined && TASK_LIST_INTENTS.has(intent)) return;
      switch (intent) {
        case 'projects':
          setPage(value => (value === 'projects' ? 'lists' : 'projects'));
          return;
        case 'tickler':
          setPage(value => (value === 'tickler' ? 'lists' : 'tickler'));
          return;
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
          if (selected !== undefined) openTask(selected.id);
          return;
        case 'close':
          if (openProject !== undefined) setOpenProject(undefined);
          else if (open !== undefined) setOpen(undefined);
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
        case 'weekly':
          setWalk(current => (current === undefined ? {index: 0} : undefined));
          return;
        case 'step-next':
          if (walk !== undefined && walk.recorded === undefined) {
            if (weekly !== undefined && walk.index === weekly.steps.length - 1) void finishWeekly();
            else stepTo(walk.index + 1);
          }
          return;
        case 'step-back':
          if (walk !== undefined && walk.recorded === undefined) stepTo(walk.index - 1);
          return;
        case 'clarify':
          if (list === 'inbox' && open === undefined) {
            clarifyInbox();
            return;
          }
          break;
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
        case 'clarify':
          actions.clarify(target);
          return;
      }
    },
    [rows, index, selected, open, openProject, page, query, actions, walk, weekly, stepTo, finishWeekly, openTask, showList],
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
    <div className={open === undefined && openProject === undefined ? 'app' : 'app with-detail'}>
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
          <CompletingInput
            inputRef={captureInput}
            value={capture}
            onChange={setCapture}
            onSubmit={submitCapture}
            suggest={captureSuggestions}
            placeholder="Capture…  #tag +project >next due:fri   (c)"
            ariaLabel="Capture a task"
            onFocusChange={setCaptureFocused}
          />
          {capture.trim().length > 0 && captureFocused && <CapturePreview line={capture} now={now} />}
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
            className={state === list && !showingProjects && page === 'lists' ? 'tab active' : 'tab'}
            onClick={() => showList(state)}
            aria-current={state === list && !showingProjects && page === 'lists' ? 'page' : undefined}
            title={`${LIST_BLURBS[state]} (${position + 1})`}
          >
            {state}
            {state !== 'done' && (data?.counts[state] ?? 0) > 0 && (
              <span className={state === 'review' ? 'count attention' : 'count'}>{data?.counts[state]}</span>
            )}
          </button>
        ))}
        <button
          className={projectsView || showingProjects ? 'tab active' : 'tab'}
          onClick={() => setPage('projects')}
          aria-current={projectsView ? 'page' : undefined}
          title="Outcomes that take more than one action (p)"
        >
          Projects
        </button>
        <button
          className={ticklerView && !showingProjects ? 'tab active' : 'tab'}
          onClick={() => setPage('tickler')}
          aria-current={ticklerView ? 'page' : undefined}
          title="Things that come back as next actions (T)"
        >
          Tickler
        </button>
        {weekly !== undefined && walk === undefined && (
          <button
            className={`tab weekly-tab${(weekly.days_since_last_review ?? 99) >= 7 ? ' due' : ''}`}
            onClick={() => setWalk({index: 0})}
            title="Walk the weekly review (W)"
          >
            Weekly review
            <span className="muted small">
              {weekly.days_since_last_review === undefined
                ? 'never'
                : weekly.days_since_last_review === 0
                  ? 'today'
                  : `${weekly.days_since_last_review}d ago`}
            </span>
          </button>
        )}
      </nav>

      <main className="list-pane">
        {walk !== undefined && weekly !== undefined && (
          <WeeklyBanner
            plan={weekly}
            index={walk.index}
            recorded={walk.recorded}
            onStep={stepTo}
            onFinish={() => void finishWeekly()}
            onExit={() => setWalk(undefined)}
            onOpenTask={openTask}
          />
        )}
        {showingProjects ? (
          <ProjectsView now={now} revision={revision} activeOnly onOpen={openProjectPanel} />
        ) : projectsView ? (
          <ProjectsView now={now} revision={revision} onOpen={openProjectPanel} onNew={() => setDialog({kind: 'new-project'})} />
        ) : ticklerView ? (
          <TicklerView now={now} revision={revision} toast={toast} onChanged={() => void reload()} />
        ) : (
          <>
        <div className="list-head">
          <div>
            <h1>{list}</h1>
            <p className="muted">{LIST_BLURBS[list]}</p>
          </div>
          <div className="list-tools">
            {list === 'inbox' && rows.length > 0 && (
              <button className="primary" onClick={clarifyInbox}>
                Clarify {rows.length === 1 ? 'it' : `all ${rows.length}`} <kbd>C</kbd>
              </button>
            )}
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
                onOpen={() => openTask(task.id)}
                onOpenProject={openProjectPanel}
              />
            ))}
          </ul>
        )}
          </>
        )}
      </main>

      {openProject !== undefined && (
        <ProjectPanel
          key={openProject}
          id={openProject}
          revision={revision}
          now={now}
          toast={toast}
          onClose={() => setOpenProject(undefined)}
          onOpenTask={openTask}
          onChanged={() => {
            void reload();
            setRevision(value => value + 1);
          }}
        />
      )}
      {open !== undefined && (
        <Detail
          key={open}
          id={open}
          revision={revision}
          now={now}
          actions={actions}
          onClose={() => setOpen(undefined)}
          onChanged={() => void reload()}
          onOpenProject={openProjectPanel}
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
      {dialog?.kind === 'new-project' && (
        <NewProjectDialog
          onClose={() => setDialog(undefined)}
          onCreated={project => {
            toast(`Started "${project.title}". Add its next action.`);
            setRevision(value => value + 1);
            openProjectPanel(project.id);
          }}
        />
      )}
      {dialog?.kind === 'clarify' && (
        <Clarify
          ids={dialog.ids}
          tagSuggest={tagSuggestions}
          walking={dialog.walking}
          now={now}
          toast={toast}
          onFiled={() => {
            void reload();
            setRevision(value => value + 1);
          }}
          onClose={() => setDialog(undefined)}
        />
      )}
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
