/**
 * Timestamps and calendar days.
 *
 * A moment is RFC3339 in UTC, to the second: `2026-09-12T10:04:00Z`, the format every log
 * line and the contract document use. Milliseconds are dropped because people read these.
 *
 * A *day* is different. "Due Friday", "defer until the 1st", "reviewed today" are all
 * about the calendar on the wall, which is local. Counting days in UTC made each of them
 * roll over at about 8pm in the US: things went overdue at dinner and deferred tasks
 * turned up the night before. So every question about which day it is goes through the
 * helpers below, and they use the local time zone — the server's, for anything the
 * server decides, and the browser's for what it displays, which on a home network are
 * the same.
 */

export function toIsoSeconds(at: Date): string {
  if (Number.isNaN(at.getTime())) throw new RangeError('not a date');
  return `${at.toISOString().slice(0, 19)}Z`;
}

/** The current time, in the file format. */
export function nowIso(): string {
  return toIsoSeconds(new Date());
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

/** The local calendar day a moment falls on, as `YYYY-MM-DD`. */
export function localDate(at: Date | string): string {
  const date = typeof at === 'string' ? new Date(at) : at;
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** Today, as `YYYY-MM-DD`, on the local calendar. */
export function todayIso(nowIsoString: string = nowIso()): string {
  return localDate(nowIsoString);
}

/** Local midnight at the start of a `YYYY-MM-DD` day, or undefined if it is not one. */
export function startOfLocalDay(day: string): Date | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day.trim());
  if (match === null) return undefined;
  const at = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return Number.isNaN(at.getTime()) ? undefined : at;
}

/** The last millisecond of a `YYYY-MM-DD` day, locally. */
export function endOfLocalDay(day: string): Date | undefined {
  const start = startOfLocalDay(day);
  if (start === undefined) return undefined;
  return new Date(start.getFullYear(), start.getMonth(), start.getDate(), 23, 59, 59, 999);
}

/** A local day shifted by whole days, safe across daylight-saving changes. */
export function addLocalDays(day: string, days: number): string | undefined {
  const start = startOfLocalDay(day);
  if (start === undefined) return undefined;
  return localDate(new Date(start.getFullYear(), start.getMonth(), start.getDate() + days));
}

/**
 * Whole calendar days from one local day to another. Counted on the calendar rather than
 * by dividing milliseconds, so a 23- or 25-hour day around a clock change is still one.
 */
export function daysBetweenLocal(fromDay: string, toDay: string): number | undefined {
  const from = startOfLocalDay(fromDay);
  const to = startOfLocalDay(toDay);
  if (from === undefined || to === undefined) return undefined;
  const utc = (d: Date) => Date.UTC(d.getFullYear(), d.getMonth(), d.getDate());
  return Math.round((utc(to) - utc(from)) / 86_400_000);
}
