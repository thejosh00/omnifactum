/**
 * The JSON an agent sees.
 *
 * This is an API contract now, not a convenience, so it is defined in one pure place
 * and asserted directly in tests. Two rules keep it predictable:
 *
 * Field names are snake_case, including `waiting_on`, and have not changed since tasks
 * were markdown files, so an agent written against the old contract still reads them.
 *
 * Absent means absent. An optional field that is not set is left out rather than
 * emitted as null.
 */
import type {LogEntry, ProjectFile, TaskFile} from './types.ts';

export interface LogEntryJson {
  at: string;
  actor: string;
  text: string;
}

export interface TaskJson {
  id: string;
  title: string;
  state: string;
  tags: string[];
  created: string;
  project?: string;
  due?: string;
  defer?: string;
  waiting_on?: string;
  asked?: string;
  done?: string;
  body: string;
  log: LogEntryJson[];
  /** A short name derived from the title, which is also a valid reference to this task. */
  stem: string;
  /**
   * Goes up by one on every change. Send it back as `If-Match` when replacing a field
   * over HTTP, and the write is refused if someone else changed the task first.
   */
  version: number;
}

export interface ProjectJson {
  id: string;
  title: string;
  outcome: string;
  state: string;
  tags: string[];
  created: string;
  due?: string;
  reviewed?: string;
  done?: string;
  aliases: string[];
  /** Tasks in next or waiting. Zero on an active project means it is stalled. */
  live_actions: number;
  stalled: boolean;
  stem: string;
  version: number;
}

function logToJson(log: readonly LogEntry[]): LogEntryJson[] {
  return log.map(entry => ({
    at: entry.at,
    actor: entry.actor,
    // A line that did not parse still has content worth handing over.
    text: entry.parsed ? entry.text : entry.raw.trim(),
  }));
}

function omitUndefined<T extends Record<string, unknown>>(value: T): T {
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (entry !== undefined) out[key] = entry;
  }
  return out as T;
}

export function taskToJson(file: TaskFile): TaskJson {
  const task = file.task;
  return omitUndefined({
    id: task.id,
    title: task.title,
    state: task.state,
    tags: task.tags,
    created: task.created,
    project: task.project,
    due: task.due,
    defer: task.defer,
    waiting_on: task.waitingOn,
    asked: task.asked,
    done: task.done,
    body: task.body.trim(),
    log: logToJson(task.log),
    stem: file.stem,
    version: file.version,
  });
}

export interface ProjectContext {
  liveActions: number;
  stalled: boolean;
}

export function projectToJson(file: ProjectFile, context: ProjectContext): ProjectJson {
  const project = file.project;
  return omitUndefined({
    id: project.id,
    title: project.title,
    outcome: project.outcome,
    state: project.state,
    tags: project.tags,
    created: project.created,
    due: project.due,
    reviewed: project.reviewed,
    done: project.done,
    aliases: project.aliases,
    live_actions: context.liveActions,
    stalled: context.stalled,
    stem: file.stem,
    version: file.version,
  });
}

/** The envelope every mutation returns, so success and failure parse the same way. */
export interface Envelope {
  ok: boolean;
  [key: string]: unknown;
}

export function ok(fields: Record<string, unknown> = {}): Envelope {
  return {ok: true, ...fields};
}

export function failure(error: string, code: number, fields: Record<string, unknown> = {}): Envelope {
  return {ok: false, error, code, ...fields};
}

/** Pretty-printed, because a person reading an agent's transcript is a real user too. */
export function renderJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}
