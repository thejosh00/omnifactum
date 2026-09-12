/**
 * Turning dates into something you can read without doing arithmetic.
 *
 * `due 2026-10-15` makes you work out whether that is soon. `due in 3d` does not, and
 * `overdue 2d` is the one you actually need to see. The files keep the exact date —
 * that is what they are for — and this is only how it reads on screen.
 */
import {instantOf} from './tickler.ts';

const DAY_MS = 86_400_000;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Whole days from one instant to another, counted by calendar day in UTC. */
export function daysUntil(target: string, nowIso: string): number | undefined {
  const to = instantOf(target);
  const from = instantOf(nowIso);
  if (to === undefined || from === undefined) return undefined;

  const startOfDay = (ms: number): number => Math.floor(ms / DAY_MS) * DAY_MS;
  return Math.round((startOfDay(to) - startOfDay(from)) / DAY_MS);
}

export type Urgency = 'overdue' | 'today' | 'soon' | 'later';

export interface DueLabel {
  text: string;
  urgency: Urgency;
}

/**
 * How a deadline reads on a row. Near dates are relative because that is the question
 * you are asking; far ones are absolute because "in 94 days" tells you nothing.
 */
export function formatDue(due: string, nowIso: string): DueLabel {
  const days = daysUntil(due, nowIso);
  if (days === undefined) return {text: `due ${due}`, urgency: 'later'};

  if (days < 0) {
    // Short, because this sits in a column and a long one pushes the row over the edge.
    return {text: `overdue ${Math.abs(days)}d`, urgency: 'overdue'};
  }
  if (days === 0) return {text: 'due today', urgency: 'today'};
  if (days === 1) return {text: 'due tomorrow', urgency: 'today'};
  if (days <= 7) return {text: `due in ${days}d`, urgency: 'soon'};
  if (days <= 90) return {text: `due ${shortDate(due)}`, urgency: 'later'};
  return {text: `due ${due.slice(0, 10)}`, urgency: 'later'};
}

/** A deferred task, read the same way. */
export function formatDefer(defer: string, nowIso: string): string {
  const days = daysUntil(defer, nowIso);
  if (days === undefined) return `hidden until ${defer}`;
  if (days <= 0) return 'ready now';
  if (days === 1) return 'hidden until tomorrow';
  if (days <= 14) return `hidden ${days}d more`;
  return `hidden until ${shortDate(defer)}`;
}

/** `15 Oct`, which is shorter than an ISO date and easier to read at a glance. */
export function shortDate(value: string): string {
  const at = instantOf(value);
  if (at === undefined) return value;
  const date = new Date(at);
  return `${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]}`;
}

/** How long ago something happened, for a log line. */
export function timeAgo(at: string, nowIso: string): string {
  const days = daysUntil(at, nowIso);
  if (days === undefined) return at;
  if (days === 0) return 'today';
  if (days === -1) return 'yesterday';
  if (days < 0 && days >= -14) return `${Math.abs(days)}d ago`;
  if (days > 0) return `in ${days}d`;
  return shortDate(at);
}

/**
 * Everything that follows the title on a row, as styled pieces.
 *
 * The row is laid out by measuring this first: the widest set of annotations among the
 * visible rows decides how much space the title gets, so every title starts and ends in
 * the same column and nothing overflows. Getting this wrong is not subtle — Ink reflows
 * the line and starts eating the spaces between words.
 *
 * Rendering and measuring share this one definition so they cannot disagree.
 */
export type MetaKind = 'project' | 'tag' | 'due' | 'defer' | 'waiting';

export interface MetaSegment {
  kind: MetaKind;
  /** The whole piece, including its marker, as it appears on screen. */
  text: string;
  /** For a tag or project, the marker that is dimmed away from the word. */
  mark?: string;
  urgency?: Urgency;
  /** A project reference that does not resolve. */
  dangling?: boolean;
}

export interface MetaInput {
  tags: readonly string[];
  project?: string | undefined;
  due?: string | undefined;
  defer?: string | undefined;
  waitingOn?: string | undefined;
}

export function metaSegments(
  task: MetaInput,
  nowIso: string,
  options: {dangling?: boolean; deferred?: boolean} = {},
): MetaSegment[] {
  const segments: MetaSegment[] = [];

  if (task.project !== undefined) {
    segments.push({
      kind: 'project',
      mark: '+',
      text: `+${task.project}${options.dangling === true ? '?' : ''}`,
      dangling: options.dangling === true,
    });
  }

  for (const tag of task.tags) {
    segments.push({kind: 'tag', mark: '#', text: `#${tag}`});
  }

  if (task.due !== undefined) {
    const due = formatDue(task.due, nowIso);
    segments.push({kind: 'due', text: due.text, urgency: due.urgency});
  }

  if (options.deferred === true && task.defer !== undefined) {
    segments.push({kind: 'defer', text: formatDefer(task.defer, nowIso)});
  }

  if (task.waitingOn !== undefined) {
    segments.push({kind: 'waiting', text: `waiting on ${task.waitingOn}`});
  }

  return segments;
}

/** How many columns the annotations take, including the single space between them. */
export function metaWidth(segments: readonly MetaSegment[]): number {
  if (segments.length === 0) return 0;
  return segments.reduce((total, segment) => total + segment.text.length, 0) + segments.length - 1;
}
