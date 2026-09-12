/**
 * The root of the interactive interface.
 *
 * The rule this file exists to keep: the UI never computes a state transition and never
 * touches the filesystem. A keypress becomes an intent, an intent calls a pure planner
 * in `core/`, the planner's result goes to the store, and the world is re-read. So
 * "pressing x completes a task, appends a log line and files it under the right month"
 * is a unit test in core, not something only a rendered terminal can prove.
 */
import React, {useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore} from 'react';
import {Box, Text, useApp, useInput, useStdin, useStdout} from 'ink';
import {applyTagEdit, formatTags, parseCapture, parseTagEdit} from '../core/capture.ts';
import {
  answerClarify,
  applyClarify,
  backClarify,
  currentQuestion,
  startClarify,
} from '../core/clarify.ts';
import {planComplete, planMove, planNewTask, planNote, planSetTags} from '../core/mutation.ts';
import {resolveProjectRef} from '../core/project.ts';
import {describeChanges} from '../core/diff.ts';
import {appendToLog, buildReview, summarize} from '../core/review.ts';
import {planReviewed} from '../core/project.ts';
import {REVIEW_FILE} from '../store/paths.ts';
import {countsByState} from '../core/snapshot.ts';
import {
  LISTS,
  indexOfSelection,
  initialView,
  moveSelection,
  reconcileSelection,
  selectFirst,
  selectLast,
  selectedTask,
  visibleTasks,
} from '../core/view.ts';
import {openInEditor} from '../store/editor.ts';
import {Banner, Hints, Rule, StatusBar} from './components/StatusBar.tsx';
import {TextInput} from './components/TextInput.tsx';
import {ClarifyScreen} from './screens/ClarifyScreen.tsx';
import {DetailScreen} from './screens/DetailScreen.tsx';
import {HelpScreen} from './screens/HelpScreen.tsx';
import {ListScreen} from './screens/ListScreen.tsx';
import {ProjectsScreen} from './screens/ProjectsScreen.tsx';
import {WeeklyHeader} from './screens/WeeklyScreen.tsx';
import {intentFor} from './keymap.ts';
import type {Intent} from './keymap.ts';
import type {ClarifyOutcome, ClarifyQuestion, ClarifySession} from '../core/clarify.ts';
import type {ListName, Mode, NotePurpose, View} from '../core/view.ts';
import type {LiveStore} from './liveStore.ts';
import type {TaskFile, TaskState} from '../core/types.ts';

export interface AppProps {
  live: LiveStore;
  /** Whether live updates are running, for the status line. */
  watching: boolean;
  initialList?: ListName;
  /**
   * What quitting does. Defaults to Ink's own exit; the tests pass their own so that
   * "q quits" is verified in process rather than inferred from a real terminal.
   */
  onExit?: () => void;
}

const EMPTY_MESSAGES: Record<ListName, string> = {
  inbox: 'Inbox zero.',
  next: 'Nothing to do right now.',
  waiting: 'Not waiting on anything.',
  someday: 'Nothing on the someday list.',
  review: 'Nothing waiting to be checked.',
  done: 'Nothing completed yet.',
};

/** What to do about an empty list, so the screen is a nudge rather than a full stop. */
const EMPTY_HINTS: Record<ListName, string | undefined> = {
  inbox: 'press c to capture something',
  next: 'press 1 to process the inbox, or c to capture',
  waiting: undefined,
  someday: undefined,
  review: 'work an agent finishes with "omni submit" lands here',
  done: undefined,
};

const TEXT_MODES: Mode[] = ['filter', 'capture', 'tags', 'note'];

const FALLBACK_ROWS = 24;
const FALLBACK_COLUMNS = 80;
/** Narrower than this and the layout is unreadable anyway, so stop shrinking. */
const MIN_COLUMNS = 40;
const MIN_ROWS = 8;

/**
 * A terminal size that is always usable.
 *
 * Some pseudo-terminals report zero for both dimensions rather than leaving them
 * undefined — `expect` does exactly this. Taken at face value, a zero width collapses
 * every box to a single character and the whole interface renders as a vertical stream
 * of letters, so anything that is not a sensible positive number is treated as unknown.
 */
function sane(value: number | undefined, fallback: number, minimum: number): number {
  if (value === undefined || !Number.isFinite(value) || value <= 0) return fallback;
  return Math.max(minimum, Math.floor(value));
}

function useTerminalSize(): {rows: number; columns: number} {
  const {stdout} = useStdout();

  const measure = useCallback(
    () => ({
      rows: sane(stdout?.rows, FALLBACK_ROWS, MIN_ROWS),
      columns: sane(stdout?.columns, FALLBACK_COLUMNS, MIN_COLUMNS),
    }),
    [stdout],
  );

  const [size, setSize] = useState(measure);

  useEffect(() => {
    if (stdout === undefined) return;
    const onResize = (): void => setSize(measure());
    stdout.on('resize', onResize);
    return () => {
      stdout.off('resize', onResize);
    };
  }, [stdout, measure]);

  return size;
}

export function App({
  live,
  watching,
  initialList = 'next',
  onExit,
}: AppProps): React.ReactElement {
  const {exit} = useApp();
  const quit = onExit ?? exit;
  const {setRawMode, isRawModeSupported} = useStdin();
  const {rows, columns} = useTerminalSize();

  const snapshot = useSyncExternalStore(live.subscribe, live.getSnapshot, live.getSnapshot);
  const [view, setView] = useState<View>(() => initialView(initialList));
  const [banner, setBanner] = useState<{message: string; tone: 'info' | 'warn' | 'error'}>();
  const [projectIndex, setProjectIndex] = useState(0);
  const [clarify, setClarify] = useState<ClarifySession>();

  const nowIso = live.now();
  const taskRows = useMemo(
    () => visibleTasks(snapshot, view, nowIso),
    [snapshot, view, nowIso],
  );

  // Selection is tracked by id, so a list rebuilt from disk — including changes an
  // agent made in another terminal — keeps the cursor where the user left it.
  const previousRows = useRef<TaskFile[]>(taskRows);
  useEffect(() => {
    const next = reconcileSelection(taskRows, previousRows.current, view.selectedId);
    previousRows.current = taskRows;
    if (next !== view.selectedId) setView(v => ({...v, selectedId: next}));
  }, [taskRows, view.selectedId]);

  const selectedIndex = indexOfSelection(taskRows, view.selectedId);
  const selected = selectedTask(taskRows, view.selectedId);

  // Looked up across the whole snapshot, not just the list on screen, so a task that
  // moves to done while you are reading it stays on screen and simply shows its new
  // state. `active` is what every action operates on, which keeps the detail view and
  // the list from ever disagreeing about which task you meant.
  const detailFile =
    view.detailId === undefined ? undefined : snapshot.byId.get(view.detailId);

  // Keyed on `detailId` rather than on the mode, because pressing `t` or `x` from the
  // detail view switches the mode to an input overlay. If `active` followed the mode it
  // would fall back to the cursor mid-edit and apply the change to a different task.
  // `detailId` is cleared on the way back to the list, so it is set exactly while the
  // detail flow is open.
  const pinned = view.detailId !== undefined;
  const active = pinned ? detailFile : selected;

  // The item being clarified is looked up by id, like the detail view, so the walk keeps
  // asking about the same thing even if the list is rebuilt underneath it.
  const clarifyFile = clarify === undefined ? undefined : snapshot.byId.get(clarify.taskId);
  const clarifyQuestion = clarify === undefined ? undefined : currentQuestion(clarify);

  const weekly = useMemo(() => buildReview(snapshot, nowIso), [snapshot, nowIso]);
  const weeklyStep = view.weeklyStep ?? 0;
  const step = weekly.steps[Math.min(weeklyStep, weekly.steps.length - 1)];
  const inWeekly = view.mode === 'weekly';

  const dangling = useMemo(
    () => new Set(snapshot.membership.orphans.map(o => o.file.task.id)),
    [snapshot],
  );

  const note = useCallback((message: string, tone: 'info' | 'warn' | 'error' = 'info') => {
    setBanner({message, tone});
  }, []);

  /**
   * Say what someone else changed, rather than letting a row quietly disappear.
   *
   * Without this the interface is correct but mute: a task an agent completes simply
   * stops being there, and you are left wondering whether you did it yourself.
   */
  useEffect(
    () =>
      live.onExternal(changes => {
        const summary = describeChanges(changes);
        if (summary !== undefined) setBanner({message: summary, tone: 'info'});
      }),
    [live],
  );

  /**
   * The task being read in the detail view was deleted by someone else. There is
   * nothing left to show, so go back rather than render an empty frame.
   */
  useEffect(() => {
    if (view.detailId === undefined || detailFile !== undefined) return;
    setView(v => ({...v, mode: 'list', detailId: undefined, input: ''}));
    setBanner({message: 'that task was deleted by someone else', tone: 'warn'});
  }, [view.detailId, detailFile]);

  const report = useCallback(
    (result: {ok: boolean; message?: string}, success: string) => {
      if (result.ok) note(success);
      else note(result.message ?? 'that did not work', 'error');
    },
    [note],
  );

  const setMode = useCallback((mode: Mode, input = '') => {
    setView(v => ({...v, mode, input, notePurpose: undefined}));
  }, []);

  /** Open the note row, remembering what the note is being written for. */
  const askForNote = useCallback((notePurpose: NotePurpose) => {
    setView(v => ({...v, mode: 'note', input: '', notePurpose}));
  }, []);

  /**
   * Close an overlay and go back to whatever it was opened from.
   *
   * Returning to the plain list unconditionally, which is what this used to do, quietly
   * threw you out of the weekly review the moment you acted on anything it turned up —
   * and out of the detail view whenever you edited a field. Finding a problem and being
   * unable to fix it without losing your place is how a ritual becomes one you skip.
   */
  const closeOverlay = useCallback(() => {
    setView(v => ({
      ...v,
      mode: v.weeklyStep !== undefined ? 'weekly' : v.detailId !== undefined ? 'detail' : 'list',
      input: '',
    }));
  }, []);

  /** Leave the thing you are in — the walk, the detail view — for the plain list. */
  const backToList = useCallback(() => {
    setClarify(undefined);
    setView(v => ({...v, mode: 'list', detailId: undefined, weeklyStep: undefined, input: ''}));
  }, []);

  /** Stop clarifying and go back to the list, without touching the item. */
  const leaveClarify = useCallback(() => {
    setClarify(undefined);
    setView(v => ({...v, mode: v.detailId !== undefined ? 'detail' : 'list', input: ''}));
  }, []);

  const switchList = useCallback((list: ListName) => {
    setView(v => ({...v, list, mode: 'list', selectedId: undefined, input: ''}));
  }, []);

  /**
   * Finish the walk: stamp every active project with today's date and append a line to
   * the review log. The stamp is what makes "which of these have I not looked at in a
   * month" answerable later, which is the question the ritual exists to remove.
   */
  const finishWeekly = useCallback(() => {
    const plan = buildReview(live.getSnapshot(), live.now());
    let stamped = 0;

    for (const entry of live.getSnapshot().membership.projects) {
      if (entry.project.project.state !== 'active') continue;
      const result = live.updateProject(entry.project.project.id, project =>
        planReviewed(project, live.now()),
      );
      if (result.ok) stamped += 1;
    }

    try {
      live.writeDocument(REVIEW_FILE, appendToLog(live.readDocument(REVIEW_FILE), summarize(plan)));
    } catch (error) {
      note(error instanceof Error ? error.message : String(error), 'error');
      return;
    }

    setView(v => ({...v, mode: 'list', weeklyStep: undefined}));
    note(
      stamped > 0
        ? `review recorded; ${stamped} project${stamped === 1 ? '' : 's'} stamped`
        : 'review recorded',
    );
  }, [live, note]);

  /**
   * Whether clarifying should walk the whole list rather than stop after one item.
   *
   * Emptying the inbox is a pass, not a decision: you answer the questions until the
   * pile is gone. Anywhere else — one task opened in the detail view, or an item picked
   * out of `next` — clarifying that one thing is what was asked for, and jumping to a
   * neighbour afterwards would be an ambush.
   */
  const walkingInbox = view.list === 'inbox' && view.detailId === undefined;

  /** Apply what the walk decided, then open the next item if there is one. */
  const finishClarify = useCallback(
    (session: ClarifySession, outcome: ClarifyOutcome) => {
      const filed =
        outcome.kind === 'discard'
          ? live.remove(session.taskId)
          : live.update(session.taskId, task =>
              applyClarify(task, outcome, {nowIso: live.now()}),
            );

      if (!filed.ok) {
        note(filed.message, 'error');
        leaveClarify();
        return;
      }
      note(outcome.kind === 'discard' ? 'dropped it' : `filed in ${outcome.state}`);

      // The item has just left the list, so the next one is whatever now sits where it
      // was. Worked out from the rows already in hand rather than waiting for the
      // reload, which happens a render later.
      const index = taskRows.findIndex(file => file.task.id === session.taskId);
      const rest = taskRows.filter(file => file.task.id !== session.taskId);
      const next = walkingInbox && index !== -1 ? rest[Math.min(index, rest.length - 1)] : undefined;

      if (next === undefined) {
        leaveClarify();
        return;
      }
      setClarify(startClarify(next.task.id));
      setView(v => ({...v, selectedId: next.task.id, input: ''}));
    },
    [live, note, leaveClarify, taskRows, walkingInbox],
  );

  const runEditor = useCallback(
    (file: TaskFile) => {
      // An editor and a live render loop cannot share a terminal, so raw mode is
      // handed back for the duration. This is the one path a test harness cannot
      // drive, since it needs a real pty.
      if (isRawModeSupported) setRawMode(false);
      const result = openInEditor(file.path);
      if (isRawModeSupported) setRawMode(true);

      live.reload();
      if (result.kind === 'no-editor') note('set $EDITOR to edit a task here', 'warn');
      else if (result.kind === 'failed') note(result.reason, 'error');
      else note(`reread ${file.stem}`);
    },
    [isRawModeSupported, setRawMode, live, note],
  );

  const handleIntent = useCallback(
    (intent: Intent): void => {
      switch (intent) {
        case 'move-down':
          setView(v => ({...v, selectedId: moveSelection(taskRows, v.selectedId, 1)}));
          return;
        case 'move-up':
          setView(v => ({...v, selectedId: moveSelection(taskRows, v.selectedId, -1)}));
          return;
        case 'page-down':
          setView(v => ({...v, selectedId: moveSelection(taskRows, v.selectedId, 10)}));
          return;
        case 'page-up':
          setView(v => ({...v, selectedId: moveSelection(taskRows, v.selectedId, -10)}));
          return;
        case 'go-top':
          setView(v => ({...v, selectedId: selectFirst(taskRows)}));
          return;
        case 'go-bottom':
          setView(v => ({...v, selectedId: selectLast(taskRows)}));
          return;

        case 'open':
          if (view.mode === 'projects') return;
          if (selected !== undefined) {
            setView(v => ({...v, mode: 'detail', detailId: selected.task.id, input: ''}));
          }
          return;
        case 'back':
          backToList();
          return;

        case 'complete':
          if (active === undefined) return;
          if (active.task.state === 'done') {
            note('already done');
            return;
          }
          askForNote({kind: 'complete'});
          return;

        case 'note':
          if (active === undefined) return;
          askForNote({kind: 'log'});
          return;

        case 'capture':
          setMode('capture');
          return;

        case 'clarify':
          if (active === undefined) return;
          setClarify(startClarify(active.task.id));
          setMode('clarify');
          return;

        case 'edit-tags':
          if (active === undefined) return;
          setMode('tags', formatTags(active.task.tags));
          return;

        case 'move-state':
          if (active === undefined) return;
          setMode('move');
          return;

        case 'open-editor':
          if (active !== undefined) runEditor(active);
          return;

        case 'delete':
          if (active === undefined) return;
          setMode('confirm-delete');
          return;

        case 'focus-filter':
          setMode('filter', view.query);
          return;
        case 'clear-filter':
          if (view.query.length > 0) {
            setView(v => ({...v, query: '', mode: 'list', input: ''}));
            note('filter cleared');
          }
          return;
        case 'toggle-deferred':
          setView(v => ({...v, showDeferred: !v.showDeferred}));
          return;

        case 'list-inbox':
          switchList('inbox');
          return;
        case 'list-next':
          switchList('next');
          return;
        case 'list-waiting':
          switchList('waiting');
          return;
        case 'list-someday':
          switchList('someday');
          return;
        case 'list-review':
          switchList('review');
          return;
        case 'list-done':
          switchList('done');
          return;

        case 'projects':
          setView(v => ({...v, mode: v.mode === 'projects' ? 'list' : 'projects'}));
          return;

        case 'weekly': {
          const first = weekly.steps[0];
          setView(v => ({
            ...v,
            mode: 'weekly',
            weeklyStep: 0,
            selectedId: undefined,
            ...(first?.list === undefined ? {} : {list: first.list}),
          }));
          return;
        }

        case 'step-next': {
          const next = weeklyStep + 1;
          if (next >= weekly.steps.length) {
            finishWeekly();
            return;
          }
          const target = weekly.steps[next];
          setView(v => ({
            ...v,
            weeklyStep: next,
            selectedId: undefined,
            ...(target?.list === undefined ? {} : {list: target.list}),
          }));
          return;
        }

        case 'step-back': {
          const previous = Math.max(0, weeklyStep - 1);
          const target = weekly.steps[previous];
          setView(v => ({
            ...v,
            weeklyStep: previous,
            selectedId: undefined,
            ...(target?.list === undefined ? {} : {list: target.list}),
          }));
          return;
        }

        case 'refresh':
          live.reload();
          note('reread from disk');
          return;
        case 'help':
          setMode('help');
          return;
        case 'quit':
          quit();
          return;
        default:
          return;
      }
    },
    [taskRows, selected, active, view.mode, view.query, setMode, askForNote, backToList, switchList, runEditor, live, note, quit, weekly, weeklyStep, finishWeekly],
  );

  const navigable =
    view.mode === 'list' ||
    view.mode === 'detail' ||
    view.mode === 'projects' ||
    view.mode === 'weekly';

  useInput(
    (input, key) => {
      if (view.mode === 'projects') {
        const entries = snapshot.membership.projects;
        if (input === 'j' || key.downArrow) {
          setProjectIndex(i => Math.min(entries.length - 1, i + 1));
          return;
        }
        if (input === 'k' || key.upArrow) {
          setProjectIndex(i => Math.max(0, i - 1));
          return;
        }
      }
      const intent = intentFor({input, ...key}, view.mode);
      if (intent !== undefined) handleIntent(intent);
    },
    {isActive: navigable},
  );

  // The help screen dismisses on anything, so it never becomes a place to get stuck.
  useInput(
    () => {
      closeOverlay();
    },
    {isActive: view.mode === 'help'},
  );

  useInput(
    (input, key) => {
      if (key.escape || input === 'q') {
        closeOverlay();
        return;
      }
      const target = MOVE_KEYS[input];
      if (target === undefined || active === undefined) return;
      if (target === active.task.state) {
        closeOverlay();
        return;
      }
      // Work leaving `review` carries a reason. Accepting it or sending it back are the
      // two things whoever picks it up next has to be able to read, and a silent
      // "Moved to next." tells them nothing — which is the whole reason the queue
      // exists. Every other move stays one keystroke.
      if (active.task.state === 'review') {
        askForNote({kind: 'move', to: target});
        return;
      }
      const result = live.update(active.task.id, task =>
        planMove(task, target, {nowIso: live.now()}),
      );
      report(result, `moved to ${target}`);
      closeOverlay();
    },
    {isActive: view.mode === 'move'},
  );

  useInput(
    (input, key) => {
      if (key.escape || input === 'q') {
        leaveClarify();
        return;
      }
      if (clarify === undefined) return;
      if (input === 'b') {
        setClarify(backClarify(clarify));
        return;
      }
      const choice = clarifyQuestion?.choices.find(option => option.key === input);
      if (choice === undefined) return;

      const next = answerClarify(clarify, choice.answer);
      if (next.outcome === undefined) setClarify(next);
      else finishClarify(next, next.outcome);
    },
    // Only while a question is answered by choosing. The typed questions are the text
    // input's, and two handlers reading the same keystroke would type and answer at once.
    {isActive: view.mode === 'clarify' && (clarifyQuestion?.choices.length ?? 0) > 0},
  );

  /**
   * The item being clarified was deleted by someone else. There is nothing left to
   * decide about, so the walk ends rather than asking about a task that is gone.
   */
  useEffect(() => {
    if (clarify === undefined || clarifyFile !== undefined) return;
    leaveClarify();
    setBanner({message: 'that task was deleted by someone else', tone: 'warn'});
  }, [clarify, clarifyFile, leaveClarify]);

  useInput(
    (input, key) => {
      if (input === 'y' || input === 'Y') {
        if (active === undefined) return;
        const stem = active.stem;
        report(live.remove(active.task.id), `deleted ${stem}`);
        closeOverlay();
        return;
      }
      if (key.escape || input === 'n' || input === 'N' || input === 'q') closeOverlay();
    },
    {isActive: view.mode === 'confirm-delete'},
  );

  const submitInput = useCallback(
    (value: string) => {
      switch (view.mode) {
        case 'filter':
          setView(v => ({...v, query: value, mode: 'list', input: '', selectedId: undefined}));
          return;

        case 'capture': {
          const captured = parseCapture(value);
          if (captured.title.length === 0) {
            closeOverlay();
            return;
          }
          const project = resolveProject(captured.project);
          const result = live.create(
            planNewTask({
              id: live.mintId(),
              title: captured.title,
              state: 'inbox',
              nowIso: live.now(),
              tags: captured.tags,
              ...(project === undefined ? {} : {project}),
            }),
          );
          report(result, `captured into inbox: ${captured.title}`);
          closeOverlay();
          return;
        }

        case 'clarify': {
          if (clarify === undefined) return;
          const next = answerClarify(clarify, value);
          if (next.outcome === undefined) {
            setClarify(next);
            setView(v => ({...v, input: ''}));
          } else {
            finishClarify(next, next.outcome);
          }
          return;
        }

        case 'tags': {
          if (active === undefined) return;
          const edit = parseTagEdit(value);
          const result = live.update(active.task.id, task =>
            planSetTags(task, applyTagEdit(task.tags, edit)),
          );
          report(result, 'tags updated');
          closeOverlay();
          return;
        }

        case 'note': {
          if (active === undefined) return;
          const purpose = view.notePurpose ?? {kind: 'complete'};
          const text = value.trim();
          const title = active.task.title;

          if (purpose.kind === 'log') {
            // A note and nothing else. An empty one would be a blank log line, so it
            // is simply a cancellation.
            if (text.length === 0) {
              closeOverlay();
              return;
            }
            const result = live.update(active.task.id, task =>
              planNote(task, {nowIso: live.now(), note: text}),
            );
            report(result, 'noted');
            closeOverlay();
            return;
          }

          if (purpose.kind === 'move') {
            const to = purpose.to;
            const result = live.update(active.task.id, task =>
              planMove(task, to, {nowIso: live.now(), ...(text.length === 0 ? {} : {note: text})}),
            );
            report(result, `moved to ${to}`);
            closeOverlay();
            return;
          }

          const result = live.update(active.task.id, task => {
            if (task.state === 'done') throw new Error('it was completed by someone else first');
            return planComplete(task, {
              nowIso: live.now(),
              ...(text.length === 0 ? {} : {note: value}),
            });
          });
          report(result, `done: ${title}`);
          closeOverlay();
          return;
        }

        default:
          closeOverlay();
      }
    },
    [view.mode, view.notePurpose, active, clarify, finishClarify, live, report, closeOverlay],
  );

  const resolveProject = useCallback(
    (ref: string | undefined): string | undefined => {
      if (ref === undefined) return undefined;
      const match = resolveProjectRef(snapshot.projects, ref);
      return match.kind === 'ok' ? match.project.stem : ref;
    },
    [snapshot.projects],
  );

  const counts = useMemo(() => countsByState(snapshot), [snapshot]);
  const tagNames = useMemo(() => snapshot.tags.map(use => use.tag), [snapshot.tags]);
  const projectStems = useMemo(() => snapshot.projects.map(file => file.stem), [snapshot.projects]);

  // Status line, the input row, the banner and the hints all take one row each.
  const chrome = 5;
  const bodyHeight = Math.max(3, rows - chrome);

  return (
    <Box flexDirection="column" width={columns}>
      <StatusBar
        list={view.list}
        counts={counts}
        shown={taskRows.length}
        query={view.query}
        showDeferred={view.showDeferred}
        watching={watching}
      />
      <Rule width={columns} />

      <Box flexDirection="column" minHeight={bodyHeight}>
        {view.mode === 'help' ? (
          <HelpScreen />
        ) : view.mode === 'projects' ? (
          <ProjectsScreen
            entries={snapshot.membership.projects}
            selectedIndex={Math.min(projectIndex, Math.max(0, snapshot.membership.projects.length - 1))}
            height={bodyHeight}
            orphanCount={snapshot.membership.orphans.length}
          />
        ) : inWeekly && step !== undefined ? (
          <Box flexDirection="column">
            <WeeklyHeader
              step={step}
              index={weeklyStep}
              total={weekly.steps.length}
              last={weeklyStep === weekly.steps.length - 1}
            />
            <Box marginTop={1} flexDirection="column">
              {step.kind === 'projects' ? (
                <ProjectsScreen
                  entries={snapshot.membership.projects}
                  selectedIndex={0}
                  height={Math.max(3, bodyHeight - 10)}
                  orphanCount={snapshot.membership.orphans.length}
                />
              ) : (
                <ListScreen
                  rows={taskRows}
                  selectedIndex={selectedIndex}
                  height={Math.max(3, bodyHeight - 10)}
                  width={columns}
                  nowIso={nowIso}
                  empty={EMPTY_MESSAGES[view.list]}
                  dangling={dangling}
                />
              )}
            </Box>
          </Box>
        ) : view.mode === 'clarify' && clarifyFile !== undefined && clarifyQuestion !== undefined ? (
          <ClarifyScreen
            file={clarifyFile}
            question={clarifyQuestion}
            remaining={walkingInbox ? taskRows.filter(f => f.task.id !== clarifyFile.task.id).length : 0}
          />
        ) : pinned && detailFile !== undefined ? (
          <DetailScreen
            file={detailFile}
            nowIso={nowIso}
            height={bodyHeight}
            dangling={dangling.has(detailFile.task.id)}
          />
        ) : (
          <ListScreen
            rows={taskRows}
            selectedIndex={selectedIndex}
            height={bodyHeight}
            width={columns}
            nowIso={nowIso}
            empty={EMPTY_MESSAGES[view.list]}
            emptyHint={EMPTY_HINTS[view.list]}
            dangling={dangling}
          />
        )}
      </Box>

      <InputRow
        view={view}
        selected={active}
        tagNames={tagNames}
        projectStems={projectStems}
        clarifyQuestion={clarifyQuestion}
        onChange={value => setView(v => ({...v, input: value}))}
        onSubmit={submitInput}
        onCancel={view.mode === 'clarify' ? leaveClarify : closeOverlay}
      />
      <Banner message={banner?.message} tone={banner?.tone ?? 'info'} />
      <Hints hints={hintsFor(view.mode, clarifyQuestion)} selectedId={active?.task.id} />
    </Box>
  );
}

const MOVE_KEYS: Record<string, TaskState | undefined> = {
  i: 'inbox',
  n: 'next',
  w: 'waiting',
  s: 'someday',
  r: 'review',
  d: 'done',
};

interface InputRowProps {
  view: View;
  selected: TaskFile | undefined;
  tagNames: string[];
  projectStems: string[];
  /** The clarify question being answered, when one is. */
  clarifyQuestion: ClarifyQuestion | undefined;
  onChange: (value: string) => void;
  onSubmit: (value: string) => void;
  onCancel: () => void;
}

function InputRow({
  view,
  selected,
  tagNames,
  projectStems,
  clarifyQuestion,
  onChange,
  onSubmit,
  onCancel,
}: InputRowProps): React.ReactElement {
  if (view.mode === 'clarify') {
    // A question answered by choosing takes its keys directly; only a typed one needs
    // the input row at all.
    if (clarifyQuestion === undefined || clarifyQuestion.choices.length > 0) {
      return <Text> </Text>;
    }
    return (
      <TextInput
        value={view.input}
        prompt="> "
        {...(clarifyQuestion.placeholder === undefined
          ? {}
          : {placeholder: clarifyQuestion.placeholder})}
        completions={clarifyQuestion.step === 'project' ? projectStems : tagNames}
        onChange={onChange}
        onSubmit={onSubmit}
        onCancel={onCancel}
      />
    );
  }

  if (view.mode === 'move') {
    return (
      <Box>
        <Text color="cyan">move to </Text>
        {LISTS.map(name => (
          <Text key={name}>
            <Text bold>{name[0]}</Text>
            {name.slice(1)}{'  '}
          </Text>
        ))}
        <Text dimColor>esc to cancel</Text>
      </Box>
    );
  }

  if (view.mode === 'confirm-delete') {
    return (
      <Box>
        <Text color="red">
          delete "{selected?.task.title ?? ''}" permanently? There is no undo.{' '}
        </Text>
        <Text bold>y</Text>
        <Text dimColor>/</Text>
        <Text bold>n</Text>
      </Box>
    );
  }

  if (!TEXT_MODES.includes(view.mode)) return <Text> </Text>;

  const config: Record<string, {prompt: string; placeholder: string; completions: string[]}> = {
    filter: {prompt: '/', placeholder: 'tag, -tag, /text, project:x', completions: tagNames},
    capture: {prompt: '+ ', placeholder: 'what needs doing?  #tag  +project', completions: []},
    tags: {prompt: '# ', placeholder: 'tags, or -tag to remove', completions: tagNames},
    note: {...notePrompt(view.notePurpose), completions: []},
  };
  const {prompt, placeholder, completions} = config[view.mode]!;

  return (
    <TextInput
      value={view.input}
      prompt={prompt}
      placeholder={placeholder}
      completions={completions}
      onChange={onChange}
      onSubmit={onSubmit}
      onCancel={onCancel}
    />
  );
}

/**
 * What the note row asks for. The wording is the whole value of the prompt: "what did
 * you do?" and "why is it going back?" want different sentences, and a reviewer given
 * the wrong question writes the wrong note.
 */
function notePrompt(purpose: NotePurpose | undefined): {prompt: string; placeholder: string} {
  switch (purpose?.kind) {
    case 'log':
      return {prompt: '· ', placeholder: 'what happened?  (enter to cancel)'};
    case 'move':
      return purpose.to === 'done'
        ? {prompt: '✓ ', placeholder: 'accepting it — anything to record?  (enter to skip)'}
        : {
            prompt: '↩ ',
            placeholder: `sending it to ${purpose.to} — what was wrong?  (enter to skip)`,
          };
    default:
      return {prompt: '✓ ', placeholder: 'what did you do?  (enter to skip)'};
  }
}

function hintsFor(mode: Mode, clarifyQuestion?: ClarifyQuestion): Array<[string, string]> {
  switch (mode) {
    case 'filter':
    case 'capture':
    case 'tags':
    case 'note':
      return [
        ['enter', 'confirm'],
        ['esc', 'cancel'],
        ['tab', 'complete'],
        ['ctrl-u', 'clear'],
        ['ctrl-w', 'delete word'],
      ];
    case 'detail':
      return [
        ['esc', 'back'],
        ['x', 'done'],
        ['t', 'tags'],
        ['N', 'note'],
        ['m', 'move'],
        ['e', '$EDITOR'],
        ['?', 'help'],
        ['q', 'quit'],
      ];
    case 'clarify':
      // A typed answer has no back: `b` there is a letter. Saying otherwise would be
      // worse than saying nothing.
      return clarifyQuestion !== undefined && clarifyQuestion.choices.length === 0
        ? [
            ['enter', 'answer'],
            ['tab', 'complete'],
            ['esc', 'leave the walk'],
          ]
        : [
            ['b', 'back a question'],
            ['esc', 'leave the walk'],
          ];
    case 'projects':
      return [
        ['j/k', 'move'],
        ['p', 'back'],
        ['?', 'help'],
        ['q', 'quit'],
      ];
    case 'help':
      return [['any key', 'back']];
    default:
      return [
        ['/', 'filter'],
        ['c', 'capture'],
        ['x', 'done'],
        ['enter', 'open'],
        ['?', 'help'],
        ['q', 'quit'],
      ];
  }
}
