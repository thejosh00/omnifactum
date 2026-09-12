/**
 * What a change to a task actually is, as pure values.
 *
 * Every planner here takes a task and returns a new one. Nothing touches the
 * filesystem, so "pressing x completes a task, appends a log line, and files it under
 * the right UTC month" is an ordinary equality test with no Ink and no disk in sight.
 * The store's only job is to carry the result to a file.
 */
import {appendLogEntry} from './log.ts';
import {normalizeTags} from './tags.ts';
import type {Task, TaskState} from './types.ts';

/** Who performed a change, as written into the log. */
export const ACTOR_USER = 'you';
export const ACTOR_APP = 'omni';

export interface ChangeContext {
  nowIso: string;
  actor?: string;
}

function withLog(task: Task, ctx: ChangeContext, text: string): Task {
  const actor = ctx.actor ?? ACTOR_USER;
  return {...task, log: appendLogEntry(task.log, ctx.nowIso, actor, text)};
}

export interface CompleteOptions extends ChangeContext {
  /** What the actor did. This is the note an agent records. */
  note?: string;
}

/**
 * Complete a task. The completion timestamp is what decides the month bucket, and it
 * is recorded in the file so the directory and the field can be reconciled later.
 */
export function planComplete(task: Task, options: CompleteOptions): Task {
  const note = options.note?.trim();
  const completed: Task = {
    ...task,
    state: 'done',
    done: options.nowIso,
  };
  return withLog(completed, options, note !== undefined && note.length > 0 ? note : 'Completed.');
}

/**
 * Hand finished work back for checking, rather than declaring it done.
 *
 * This is what an agent does instead of completing a task. The work is performed, but
 * acceptance is someone else's call, so the task lands in `review/` where a person will
 * actually see it. Completing it outright would file it under `done/YYYY-MM/`, out of
 * every default view, and the one thing you most need to do with an agent's work — look
 * at it — would depend on remembering to go and find it.
 *
 * The note is required, and that is the whole point: a submission with nothing to read
 * gives the reviewer nothing to review.
 */
export function planSubmit(task: Task, options: ChangeContext & {note: string}): Task {
  const note = options.note.trim();
  if (note.length === 0) {
    throw new Error('a submission needs a note saying what you did');
  }

  const submitted: Task = {...task, state: 'review'};
  // Not done yet: acceptance is what sets this, and only a person can accept.
  delete submitted.done;
  delete submitted.defer;
  delete submitted.waitingOn;
  delete submitted.asked;

  return withLog(submitted, options, note);
}

/** Move a task between states, keeping the fields that only make sense in some of them. */
export function planMove(task: Task, to: TaskState, options: ChangeContext & {note?: string}): Task {
  if (to === 'done') {
    return planComplete(task, options);
  }

  const moved: Task = {...task, state: to};

  // `done` belongs only to a completed task.
  delete moved.done;

  // `defer` is only meaningful in someday/, because next/ has to be readable at face
  // value by an agent that just lists the directory.
  if (to !== 'someday') delete moved.defer;

  // `waiting_on` and `asked` describe a delegation, which ends when the task leaves
  // waiting/.
  if (to === 'waiting') {
    // When the delegation started, which is the only thing that makes "this has been
    // waiting nine days — chase it?" answerable. Nothing used to set it, so the weekly
    // review's one genuinely proactive check could never fire unless someone typed the
    // field into the frontmatter by hand. An existing date is kept: coming back through
    // waiting/ does not mean you asked again.
    moved.asked = task.asked ?? options.nowIso;
  } else {
    delete moved.waitingOn;
    delete moved.asked;
  }

  const note = options.note?.trim();
  return withLog(moved, options, note !== undefined && note.length > 0 ? note : `Moved to ${to}.`);
}

/**
 * Promote a deferred task whose date has arrived. Separate from `planMove` so the
 * sweep's log line says what actually happened.
 */
export function planPromote(task: Task, options: ChangeContext): Task {
  const promoted: Task = {...task, state: 'next'};
  const was = promoted.defer;
  delete promoted.defer;
  return withLog(
    promoted,
    {...options, actor: options.actor ?? ACTOR_APP},
    `Deferred until ${was ?? 'now'}; promoted to next.`,
  );
}

export function planSetTags(task: Task, tags: Iterable<string>): Task {
  return {...task, tags: normalizeTags(tags).tags};
}

export function planAddTags(task: Task, add: Iterable<string>): Task {
  return planSetTags(task, [...task.tags, ...add]);
}

export function planRemoveTags(task: Task, remove: Iterable<string>): Task {
  const drop = new Set(normalizeTags(remove).tags);
  return {...task, tags: task.tags.filter(tag => !drop.has(tag))};
}

export function planSetTitle(task: Task, title: string): Task {
  const trimmed = title.trim();
  if (trimmed.length === 0) throw new Error('a task needs a title');
  return {...task, title: trimmed};
}

/** Attach a note to the log without changing anything else. */
export function planNote(task: Task, options: ChangeContext & {note: string}): Task {
  return withLog(task, options, options.note);
}

export interface NewTaskInput extends ChangeContext {
  id: string;
  title: string;
  state: TaskState;
  tags?: Iterable<string>;
  body?: string;
  project?: string;
  due?: string;
  defer?: string;
  waitingOn?: string;
  /** When the delegation started. Defaults to now for anything created in `waiting`. */
  asked?: string;
  note?: string;
}

export function planNewTask(input: NewTaskInput): Task {
  const title = input.title.trim();
  if (title.length === 0) throw new Error('a task needs a title');

  const task: Task = {
    id: input.id,
    title,
    created: input.nowIso,
    state: input.state,
    tags: normalizeTags(input.tags ?? []).tags,
    body: input.body ?? '',
    log: [],
    repairs: [],
  };

  if (input.project !== undefined) task.project = input.project;
  if (input.due !== undefined) task.due = input.due;
  if (input.defer !== undefined && input.state === 'someday') task.defer = input.defer;
  if (input.waitingOn !== undefined && input.state === 'waiting') task.waitingOn = input.waitingOn;
  // Captured straight into waiting/ is still a delegation, and it starts now.
  if (input.state === 'waiting') task.asked = input.asked ?? input.nowIso;
  if (input.state === 'done') task.done = input.nowIso;

  const note = input.note?.trim();
  return note !== undefined && note.length > 0 ? withLog(task, input, note) : task;
}
