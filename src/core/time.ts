/**
 * Timestamps, in the one format the files use.
 *
 * RFC3339 in UTC, to the second. Milliseconds are dropped because these dates are read
 * by people in a plain text file, and `2026-09-12T10:04:00Z` is the format the contract
 * document and every example promise.
 */

export function toIsoSeconds(at: Date): string {
  if (Number.isNaN(at.getTime())) throw new RangeError('not a date');
  return `${at.toISOString().slice(0, 19)}Z`;
}

/** The current time, in the file format. */
export function nowIso(): string {
  return toIsoSeconds(new Date());
}

/** Today, as `YYYY-MM-DD`, in UTC to match the month buckets. */
export function todayIso(nowIsoString: string = nowIso()): string {
  return nowIsoString.slice(0, 10);
}
