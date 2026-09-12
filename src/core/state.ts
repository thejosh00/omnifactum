/**
 * The mapping between a GTD state and the directory that expresses it.
 *
 * The directory *is* the state. There is no `state:` field, and nothing may infer a
 * state from anything else, because an agent moving a file with `mv` has to be enough
 * to change it.
 */
import {PROJECT_STATES, TASK_STATES, isProjectState, isTaskState} from './types.ts';
import type {ProjectState, TaskState} from './types.ts';

export const PROJECTS_DIR = 'projects';

/**
 * The month bucket for a completed item, always in UTC.
 *
 * UTC is not incidental. An agent completing a task at 23:50 local time on the last
 * day of a month would otherwise file it under the wrong month, so the arithmetic is
 * pinned here and spelled out in AGENTS.md.
 */
export function doneMonth(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) {
    throw new RangeError(`not a timestamp: ${iso}`);
  }
  const year = at.getUTCFullYear();
  const month = String(at.getUTCMonth() + 1).padStart(2, '0');
  return `${year}-${month}`;
}

export function isDoneMonth(value: string): boolean {
  return /^\d{4}-(0[1-9]|1[0-2])$/.test(value);
}

/** The directory a task in this state belongs in, relative to the data dir. */
export function taskDir(state: TaskState, doneIso?: string): string {
  if (state !== 'done') return state;
  if (doneIso === undefined) {
    throw new Error('a completed task needs a completion timestamp to be filed');
  }
  return `done/${doneMonth(doneIso)}`;
}

/** The directory a project in this state belongs in, relative to the data dir. */
export function projectDir(state: ProjectState, doneIso?: string): string {
  if (state !== 'done') return `${PROJECTS_DIR}/${state}`;
  if (doneIso === undefined) {
    throw new Error('a completed project needs a completion timestamp to be filed');
  }
  return `${PROJECTS_DIR}/done/${doneMonth(doneIso)}`;
}

export interface TaskLocation {
  state: TaskState;
  /** Present only for `done`, e.g. `2026-09`. */
  month?: string;
}

/**
 * Read a task's state back out of its directory. Returns undefined for any directory
 * the app does not recognise, which is how unknown folders stay invisible rather than
 * being adopted or deleted.
 */
export function taskStateFromDir(relativeDir: string): TaskLocation | undefined {
  const parts = relativeDir.split('/').filter(p => p.length > 0);
  const [head, second, ...rest] = parts;
  if (head === undefined) return undefined;
  if (head === PROJECTS_DIR) return undefined;

  if (head === 'done') {
    // `done/` must be exactly one month bucket deep.
    if (second === undefined || rest.length > 0 || !isDoneMonth(second)) return undefined;
    return {state: 'done', month: second};
  }

  if (second !== undefined) return undefined; // no nesting under the other states
  return isTaskState(head) ? {state: head} : undefined;
}

export interface ProjectLocation {
  state: ProjectState;
  month?: string;
}

export function projectStateFromDir(relativeDir: string): ProjectLocation | undefined {
  const parts = relativeDir.split('/').filter(p => p.length > 0);
  const [head, second, third, ...rest] = parts;
  if (head !== PROJECTS_DIR || second === undefined) return undefined;

  if (second === 'done') {
    if (third === undefined || rest.length > 0 || !isDoneMonth(third)) return undefined;
    return {state: 'done', month: third};
  }

  if (third !== undefined) return undefined;
  return isProjectState(second) ? {state: second} : undefined;
}

/** Every directory `omni init` creates. `done/` months are made on demand. */
export function baseDirectories(): string[] {
  return [
    ...TASK_STATES.filter(s => s !== 'done'),
    'done',
    ...PROJECT_STATES.filter(s => s !== 'done').map(s => `${PROJECTS_DIR}/${s}`),
    `${PROJECTS_DIR}/done`,
  ];
}
