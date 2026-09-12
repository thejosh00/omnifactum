/**
 * The domain model. Pure values only — nothing here knows about the filesystem,
 * React, the clock, or randomness.
 */

/** A task's state is the directory it lives in. Nothing else defines it. */
export const TASK_STATES = [
  'inbox',
  'next',
  'waiting',
  'someday',
  // Work an agent has finished but nobody has checked. Not part of GTD, which has no
  // name for it because in GTD you do the work yourself and know when it is done.
  // Delegating to something that cannot be taken on trust is what makes it necessary.
  // It sits just before `done`, so the keys for the older lists do not shift.
  'review',
  'done',
] as const;
export type TaskState = (typeof TASK_STATES)[number];

/** Projects are stated the same way, by directory, so there is one rule not two. */
export const PROJECT_STATES = ['active', 'someday', 'done'] as const;
export type ProjectState = (typeof PROJECT_STATES)[number];

export function isTaskState(value: string): value is TaskState {
  return (TASK_STATES as readonly string[]).includes(value);
}

export function isProjectState(value: string): value is ProjectState {
  return (PROJECT_STATES as readonly string[]).includes(value);
}

/**
 * The states written out for a person to read: "inbox, next, waiting, someday, review,
 * done".
 *
 * Every message, usage line and document that names the states is built from here.
 * Four of them were spelled out by hand instead, and not one was updated when `review`
 * was added — so the app told people about five states while having six, and
 * `omni list -s review` quietly listed something else. A hand-written list of states is
 * a state that will be missed.
 */
export function taskStateList(separator = ', '): string {
  return TASK_STATES.join(separator);
}

/** The same states as a usage line spells them: `<inbox|next|…>`. */
export function taskStateChoices(): string {
  return `<${TASK_STATES.join('|')}>`;
}

/**
 * The states reachable as a bare `omni <state>` listing.
 *
 * `done` is absent because that name is already the command that completes a task;
 * completed tasks are listed with `omni list -s done`.
 */
export const LIST_STATES = TASK_STATES.filter(
  (state): state is Exclude<TaskState, 'done'> => state !== 'done',
);

/**
 * One line under the trailing `## Log` heading. `raw` is the original line and is
 * what gets written back, so a line we only partly understood is never reformatted.
 */
export interface LogEntry {
  /** RFC3339 UTC, e.g. 2026-09-12T11:03:00Z. Empty when the line did not parse. */
  at: string;
  /** `you`, `omni`, or `agent:<name>`. Empty when the line did not name one. */
  actor: string;
  text: string;
  raw: string;
  /** False when the line sits under `## Log` but is not a recognisable entry. */
  parsed: boolean;
}

/** A problem found while reading a file, and whether reading repaired it. */
export interface Repair {
  kind:
    | 'missing-id'
    | 'missing-title'
    | 'missing-created'
    | 'coerced-tag'
    | 'invalid-tag'
    | 'defer-outside-someday'
    | 'done-month-mismatch'
    | 'missing-done'
    | 'missing-outcome'
    | 'unparsable-frontmatter'
    | 'duplicate-id';
  detail: string;
}

export interface Task {
  id: string;
  title: string;
  /** RFC3339 UTC. */
  created: string;
  state: TaskState;
  tags: string[];
  /** A project file's stem, an id, or an alias. Resolved leniently. */
  project?: string;
  /** Date or datetime. A hard deadline. */
  due?: string;
  /** Date or datetime. Only meaningful in `someday/`; promotes to `next/` on arrival. */
  defer?: string;
  /** Only meaningful in `waiting/`. */
  waitingOn?: string;
  /** When you asked, for items in `waiting/`. */
  asked?: string;
  /** RFC3339 UTC. Present for items in `done/`. */
  done?: string;
  /** Markdown between the frontmatter and the `## Log` heading. Opaque to the app. */
  body: string;
  log: LogEntry[];
  /** Frontmatter keys the app does not know about, preserved verbatim on write. */
  repairs: Repair[];
}

export interface Project {
  id: string;
  title: string;
  /** The GTD successful-outcome statement. Required; an empty one is a finding. */
  outcome: string;
  created: string;
  state: ProjectState;
  tags: string[];
  due?: string;
  /** Date the project was last reviewed, stamped by `omni review`. */
  reviewed?: string;
  /** RFC3339 UTC. Present once the project is done, and decides its month bucket. */
  done?: string;
  /** Former filename stems, so the app's own renames do not orphan member tasks. */
  aliases: string[];
  body: string;
  log: LogEntry[];
  repairs: Repair[];
}

/** A parsed entity plus where it came from. The store owns this; core does not. */
export interface TaskFile {
  task: Task;
  path: string;
  /** The filename stem, which is a label and never an identity. */
  stem: string;
  mtimeMs: number;
  size: number;
  /** The exact bytes read, so an unmodified write can be byte-identical. */
  raw: string;
}

export interface ProjectFile {
  project: Project;
  path: string;
  stem: string;
  mtimeMs: number;
  size: number;
  raw: string;
}

/** A file under the data dir that could not be parsed. Never rewritten, only reported. */
export interface DamagedFile {
  path: string;
  stem: string;
  reason: string;
}
