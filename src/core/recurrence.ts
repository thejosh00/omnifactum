/**
 * Recurring tickler items: when they fire, as pure date arithmetic.
 *
 * A tickler item is a reminder that comes back — every Monday, on the 15th, or once on a
 * given day — and turns into a next action tagged `#tickler` when it does. This module
 * only answers "which day is the next firing"; creating the task is `db/tickler.ts`.
 *
 * Days are local calendar days (`YYYY-MM-DD`), like due and defer dates: an item for
 * Monday fires when Monday starts on the wall clock, not at 7pm on Sunday.
 */
import {resolveDate, weekdayIndex} from './filter.ts';
import {addLocalDays, localDate, startOfLocalDay} from './time.ts';

/** The tag every task made by a tickler item carries. */
export const TICKLER_TAG = 'tickler';

export type Schedule =
  | {kind: 'weekly'; weekday: number}
  | {kind: 'monthly'; day: number}
  | {kind: 'once'; date: string};

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function weekdayOf(day: string): number {
  return startOfLocalDay(day)!.getDay();
}

/** The `day`th of the month `day` falls in, pulled back to the month's last day if it is short. */
function monthlyIn(year: number, month: number, dayOfMonth: number): string {
  const last = new Date(year, month + 1, 0).getDate();
  return localDate(new Date(year, month, Math.min(dayOfMonth, last)));
}

/** The first firing on or after `day`. A one-off in the past is still its own date: it is overdue. */
export function firstOn(schedule: Schedule, day: string): string {
  switch (schedule.kind) {
    case 'once':
      return schedule.date;
    case 'weekly':
      return addLocalDays(day, (schedule.weekday - weekdayOf(day) + 7) % 7)!;
    case 'monthly': {
      const start = startOfLocalDay(day)!;
      const here = monthlyIn(start.getFullYear(), start.getMonth(), schedule.day);
      return here >= day ? here : monthlyIn(start.getFullYear(), start.getMonth() + 1, schedule.day);
    }
  }
}

/** The first firing strictly after `day`, or undefined for a one-off, which fires once. */
export function nextAfter(schedule: Schedule, day: string): string | undefined {
  if (schedule.kind === 'once') return undefined;
  return firstOn(schedule, addLocalDays(day, 1)!);
}

function ordinal(n: number): string {
  const tens = n % 100;
  if (tens >= 11 && tens <= 13) return `${n}th`;
  return `${n}${['th', 'st', 'nd', 'rd'][n % 10] ?? 'th'}`;
}

/** A short date for people: `Mon Sep 28`. */
export function shortDay(day: string): string {
  const at = startOfLocalDay(day);
  if (at === undefined) return day;
  return `${DAY_NAMES[at.getDay()]!.slice(0, 3)} ${MONTHS[at.getMonth()]} ${at.getDate()}`;
}

/** "every Monday", "monthly on the 15th", "once on Thu Oct 1". */
export function describeSchedule(schedule: Schedule): string {
  switch (schedule.kind) {
    case 'weekly':
      return `every ${DAY_NAMES[schedule.weekday]}`;
    case 'monthly':
      return `monthly on the ${ordinal(schedule.day)}`;
    case 'once':
      return `once on ${shortDay(schedule.date)}`;
  }
}

/** The text form, the inverse of `parseSchedule`: `weekly:mon`, `monthly:15`, `2026-10-01`. */
export function scheduleText(schedule: Schedule): string {
  switch (schedule.kind) {
    case 'weekly':
      return `weekly:${DAY_NAMES[schedule.weekday]!.slice(0, 3).toLowerCase()}`;
    case 'monthly':
      return `monthly:${schedule.day}`;
    case 'once':
      return schedule.date;
  }
}

export type ScheduleParse = {ok: true; schedule: Schedule} | {ok: false; error: string};

export function weeklyOn(word: string): ScheduleParse {
  const weekday = weekdayIndex(word.trim().toLowerCase());
  return weekday === undefined
    ? {ok: false, error: `"${word}" is not a weekday`}
    : {ok: true, schedule: {kind: 'weekly', weekday}};
}

export function monthlyOn(text: string): ScheduleParse {
  const day = Number(text.trim());
  return Number.isInteger(day) && day >= 1 && day <= 31
    ? {ok: true, schedule: {kind: 'monthly', day}}
    : {ok: false, error: `"${text}" is not a day of the month (1–31)`};
}

export function onceOn(text: string, nowIso: string): ScheduleParse {
  const date = resolveDate(text, nowIso);
  return date === undefined
    ? {ok: false, error: `"${text}" is not a date`}
    : {ok: true, schedule: {kind: 'once', date}};
}

/** Read `weekly:mon`, `monthly:15`, or anything `resolveDate` takes (`fri`, `2026-10-01`) as a one-off. */
export function parseSchedule(text: string, nowIso: string): ScheduleParse {
  const trimmed = text.trim().toLowerCase();
  const weekly = /^weekly:(.+)$/.exec(trimmed);
  if (weekly !== null) return weeklyOn(weekly[1]!);
  const monthly = /^monthly:(.+)$/.exec(trimmed);
  if (monthly !== null) return monthlyOn(monthly[1]!);
  return onceOn(trimmed, nowIso);
}

/** Check a schedule that arrived as data, from the database or a request body. */
export function asSchedule(value: unknown): Schedule | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const input = value as Record<string, unknown>;
  if (input['kind'] === 'weekly' && Number.isInteger(input['weekday']) && (input['weekday'] as number) >= 0 && (input['weekday'] as number) <= 6) {
    return {kind: 'weekly', weekday: input['weekday'] as number};
  }
  if (input['kind'] === 'monthly' && Number.isInteger(input['day']) && (input['day'] as number) >= 1 && (input['day'] as number) <= 31) {
    return {kind: 'monthly', day: input['day'] as number};
  }
  if (input['kind'] === 'once' && typeof input['date'] === 'string' && startOfLocalDay(input['date']) !== undefined) {
    return {kind: 'once', date: input['date']};
  }
  return undefined;
}

/** One tickler item. `nextOn` is the day it next fires; it is due once today reaches it. */
export interface Tickler {
  id: string;
  title: string;
  schedule: Schedule;
  nextOn: string;
  /** The task the last firing made, so a firing can hold off while that one is still open. */
  lastTaskId?: string;
  created: string;
}

export interface TicklerFile {
  tickler: Tickler;
  version: number;
}

/** The wire shape, for the web app and `omni tickler --json`. */
export function ticklerToJson(file: TicklerFile): Record<string, unknown> {
  const {tickler} = file;
  return {
    id: tickler.id,
    title: tickler.title,
    schedule: tickler.schedule,
    schedule_text: scheduleText(tickler.schedule),
    description: describeSchedule(tickler.schedule),
    next_on: tickler.nextOn,
    ...(tickler.lastTaskId === undefined ? {} : {last_task_id: tickler.lastTaskId}),
    created: tickler.created,
    version: file.version,
  };
}
