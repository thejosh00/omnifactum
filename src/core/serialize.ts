/**
 * The JSON an agent sees.
 *
 * This is an API contract now, not a convenience, so it is defined in one pure place
 * and asserted directly in tests. Two rules keep it predictable:
 *
 * Field names match the frontmatter exactly, including `waiting_on`, so an agent that
 * has looked at a file and an agent that has only ever called the CLI are talking about
 * the same thing by the same name.
 *
 * Absent means absent. An optional field that is not set is left out rather than
 * emitted as null, which is what the files do too.
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
  /** Absolute path, so an agent can read or diff the file directly if it wants to. */
  path: string;
  /** The filename stem, which is also a valid reference to this task. */
  stem: string;
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
  path: string;
  stem: string;
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
    path: file.path,
    stem: file.stem,
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
    path: file.path,
    stem: file.stem,
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
