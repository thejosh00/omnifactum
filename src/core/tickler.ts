/**
 * Due dates and defer dates.
 *
 * A deferred task lives in `someday/` with a `defer:` date and moves to `next/` when
 * that date arrives. Keeping `defer` out of `next/` is what lets `next/` be read
 * literally: if a file is in there, it is actionable now. That matters more here than
 * in most task managers, because an agent reads the directory rather than asking the
 * app.
 *
 * The promotion happens when `omni` runs, since there is no daemon. That is the honest
 * limitation, and `AGENTS.md` states the rule so an agent can apply it itself.
 */
import type {Task} from './types.ts';

/** A bare `YYYY-MM-DD`, as opposed to a full timestamp. */
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The instant a date-ish field refers to. A bare date means the start of that day in
 * UTC, which matches how the month buckets are computed.
 */
export function instantOf(value: string): number | undefined {
  const trimmed = value.trim();
  const at = new Date(DATE_ONLY.test(trimmed) ? `${trimmed}T00:00:00Z` : trimmed);
  const ms = at.getTime();
  return Number.isNaN(ms) ? undefined : ms;
}

/** The end of the day a bare date refers to, for deciding whether a deadline has passed. */
function endOf(value: string): number | undefined {
  const trimmed = value.trim();
  if (!DATE_ONLY.test(trimmed)) return instantOf(trimmed);
  const at = new Date(`${trimmed}T23:59:59.999Z`);
  return Number.isNaN(at.getTime()) ? undefined : at.getTime();
}

/** Whether a defer date has arrived. An unparsable date is treated as arrived. */
export function deferReached(defer: string, nowIso: string): boolean {
  const at = instantOf(defer);
  if (at === undefined) return true;
  const now = instantOf(nowIso);
  return now === undefined || now >= at;
}

/**
 * Whether a task should be hidden from a default listing because it is not ready yet.
 * Only `someday/` tasks can be deferred, so only they can be hidden this way.
 */
export function isDeferred(task: Task, nowIso: string): boolean {
  if (task.defer === undefined) return false;
  return !deferReached(task.defer, nowIso);
}

/** Whether a deadline has passed. A bare date is overdue only once the day is over. */
export function isOverdue(task: Task, nowIso: string): boolean {
  if (task.due === undefined || task.state === 'done') return false;
  const deadline = endOf(task.due);
  const now = instantOf(nowIso);
  if (deadline === undefined || now === undefined) return false;
  return now > deadline;
}

/** Whether a deadline falls on or before the given day. */
export function isDueBy(task: Task, isoDate: string, nowIso: string): boolean {
  if (task.due === undefined || task.state === 'done') return false;
  const deadline = instantOf(task.due);
  const limit = endOf(isoDate) ?? instantOf(nowIso);
  if (deadline === undefined || limit === undefined) return false;
  return deadline <= limit;
}

/** Tasks in `someday/` whose defer date has arrived, in a stable order. */
export function readyToPromote<T extends {task: Task}>(files: readonly T[], nowIso: string): T[] {
  return files.filter(
    file =>
      file.task.state === 'someday' &&
      file.task.defer !== undefined &&
      deferReached(file.task.defer, nowIso),
  );
}

/** Sort key for a deadline view: soonest first, undated last. */
export function byDueDate(a: Task, b: Task): number {
  const left = a.due === undefined ? Number.POSITIVE_INFINITY : (instantOf(a.due) ?? Number.POSITIVE_INFINITY);
  const right = b.due === undefined ? Number.POSITIVE_INFINITY : (instantOf(b.due) ?? Number.POSITIVE_INFINITY);
  return left - right || a.id.localeCompare(b.id);
}
