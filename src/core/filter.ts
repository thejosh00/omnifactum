/**
 * The query language, used by both the command line and the interactive filter bar.
 *
 *   query := term*                   space-separated terms are ANDed
 *   term  := ['-'] atom (',' atom)*  commas are ORed, a leading '-' negates the group
 *   atom  := tag | field:value | /text
 *
 * So `home errand` is both, `home,errand` is either, `-someday` excludes, and
 * `-home,errand` excludes both.
 *
 * Parentheses and arbitrary boolean nesting are an explicit non-goal. One level of
 * AND-of-ORs covers the queries people actually type and stays typeable at a prompt.
 * Past that you are building a query language, and this is a task list.
 */
import {isDeferred, isDueBy, isOverdue} from './tickler.ts';
import {normalizeTag} from './tags.ts';
import {addLocalDays, localDate, startOfLocalDay} from './time.ts';
import {isTaskState} from './types.ts';
import type {Task} from './types.ts';

export type Atom =
  | {kind: 'tag'; tag: string}
  | {kind: 'text'; text: string}
  | {kind: 'state'; state: string}
  | {kind: 'project'; value: string}
  | {kind: 'waiting-on'; value: string}
  | {kind: 'due'; comparison: '<=' | '>=' | '='; value: string}
  | {kind: 'has'; field: string}
  | {kind: 'is'; quality: string};

export interface Term {
  negated: boolean;
  atoms: Atom[];
}

export type Query = Term[];

export interface ParsedQuery {
  query: Query;
  /** Unrecognised input, reported so a typo does not silently match everything. */
  warnings: string[];
}

export interface EvalContext {
  nowIso: string;
  /** Resolves `today`, `tomorrow`, `+7d` into a date, on the local calendar. */
  today?: string;
}

const FIELD_PREFIXES = ['state', 'project', 'waiting_on', 'due', 'has', 'no', 'is'] as const;

export function parseQuery(input: string): ParsedQuery {
  const warnings: string[] = [];
  const query: Query = [];

  for (const raw of input.split(/\s+/).filter(t => t.length > 0)) {
    const negated = raw.startsWith('-') || raw.startsWith('!');
    const body = negated ? raw.slice(1) : raw;
    if (body.length === 0) {
      warnings.push(`"${raw}" is not a filter`);
      continue;
    }

    const atoms: Atom[] = [];
    for (const piece of body.split(',')) {
      if (piece.length === 0) continue;
      const atom = parseAtom(piece, warnings);
      if (atom !== undefined) atoms.push(atom);
    }
    if (atoms.length > 0) query.push({negated, atoms});
  }

  return {query, warnings};
}

function parseAtom(piece: string, warnings: string[]): Atom | undefined {
  if (piece.startsWith('/')) {
    const text = piece.slice(1);
    if (text.length === 0) {
      warnings.push('"/" needs something to search for');
      return undefined;
    }
    return {kind: 'text', text: text.toLowerCase()};
  }

  const colon = piece.indexOf(':');
  if (colon > 0) {
    const field = piece.slice(0, colon).toLowerCase();
    const value = piece.slice(colon + 1);
    if ((FIELD_PREFIXES as readonly string[]).includes(field)) {
      return parseField(field, value, warnings);
    }
  }

  const tag = normalizeTag(piece);
  if (tag.length === 0) {
    warnings.push(`"${piece}" is not a tag`);
    return undefined;
  }
  return {kind: 'tag', tag};
}

function parseField(field: string, value: string, warnings: string[]): Atom | undefined {
  switch (field) {
    case 'state':
      if (!isTaskState(value)) {
        warnings.push(`"${value}" is not a state`);
        return undefined;
      }
      return {kind: 'state', state: value};
    case 'project':
      return {kind: 'project', value: value.toLowerCase()};
    case 'waiting_on':
      return {kind: 'waiting-on', value: value.toLowerCase()};
    case 'due': {
      const match = /^(<=|>=|=)?(.+)$/.exec(value);
      if (match === null) {
        warnings.push(`"${value}" is not a date`);
        return undefined;
      }
      return {
        kind: 'due',
        comparison: (match[1] as '<=' | '>=' | '=' | undefined) ?? '<=',
        value: match[2]!,
      };
    }
    case 'has':
      return {kind: 'has', field: value.toLowerCase()};
    case 'no':
      // `no:project` is exactly `-has:project`, handled by negating at evaluation.
      return {kind: 'has', field: `!${value.toLowerCase()}`};
    case 'is':
      return {kind: 'is', quality: value.toLowerCase()};
    default:
      return undefined;
  }
}

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

/**
 * A weekday name, full or abbreviated to three letters or more, as its index.
 * `fri`, `frid` and `friday` all work; `f` and `fr` are too easily something else.
 */
export function weekdayIndex(word: string): number | undefined {
  if (word.length < 3) return undefined;
  const index = WEEKDAYS.findIndex(day => day.startsWith(word));
  return index === -1 ? undefined : index;
}

/**
 * Resolve `today`, `tomorrow`, `+7d`, a weekday and ISO dates into a local `YYYY-MM-DD`.
 *
 * A weekday means the next one *after* today: said on a Friday, `fri` is a week away,
 * because if you meant today you would have said `today`. Anything that shows the
 * resolved date back — the capture preview does — makes that visible before it matters.
 */
export function resolveDate(value: string, nowIso: string): string | undefined {
  const trimmed = value.trim().toLowerCase();
  const now = new Date(nowIso);
  if (Number.isNaN(now.getTime())) return undefined;
  const today = localDate(now);

  if (trimmed === 'today') return today;
  if (trimmed === 'tomorrow') return addLocalDays(today, 1);
  if (trimmed === 'yesterday') return addLocalDays(today, -1);

  const relative = /^([+-])(\d+)([dwm])$/.exec(trimmed);
  if (relative !== null) {
    const sign = relative[1] === '-' ? -1 : 1;
    const amount = Number(relative[2]);
    const unit = relative[3];
    const days = unit === 'w' ? amount * 7 : unit === 'm' ? amount * 30 : amount;
    return addLocalDays(today, sign * days);
  }

  const weekday = weekdayIndex(trimmed);
  if (weekday !== undefined) {
    const ahead = ((weekday - now.getDay() + 7) % 7) || 7;
    return addLocalDays(today, ahead);
  }

  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return startOfLocalDay(trimmed) === undefined ? undefined : trimmed;
  return undefined;
}

/** The local day a due date falls on: a bare date is already one, a timestamp is converted. */
function dueDay(due: string): string {
  const trimmed = due.trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(trimmed) ? trimmed : localDate(trimmed);
}

function matchesAtom(atom: Atom, task: Task, ctx: EvalContext): boolean {
  switch (atom.kind) {
    case 'tag':
      return task.tags.includes(atom.tag);
    case 'text':
      return (
        task.title.toLowerCase().includes(atom.text) || task.body.toLowerCase().includes(atom.text)
      );
    case 'state':
      return task.state === atom.state;
    case 'project':
      return task.project?.toLowerCase() === atom.value;
    case 'waiting-on':
      return task.waitingOn?.toLowerCase().includes(atom.value) ?? false;
    case 'due': {
      const date = resolveDate(atom.value, ctx.nowIso);
      if (date === undefined || task.due === undefined) return false;
      if (atom.comparison === '=') return dueDay(task.due) === date;
      if (atom.comparison === '<=') return isDueBy(task, date, ctx.nowIso);
      return !isDueBy(task, date, ctx.nowIso) || dueDay(task.due) === date;
    }
    case 'has': {
      const negated = atom.field.startsWith('!');
      const field = negated ? atom.field.slice(1) : atom.field;
      const present = hasField(task, field);
      return negated ? !present : present;
    }
    case 'is':
      return hasQuality(task, atom.quality, ctx);
    default:
      return false;
  }
}

function hasField(task: Task, field: string): boolean {
  switch (field) {
    case 'project':
      return task.project !== undefined;
    case 'due':
      return task.due !== undefined;
    case 'defer':
      return task.defer !== undefined;
    case 'tags':
      return task.tags.length > 0;
    case 'waiting_on':
      return task.waitingOn !== undefined;
    case 'body':
      return task.body.trim().length > 0;
    case 'log':
      return task.log.length > 0;
    default:
      return false;
  }
}

function hasQuality(task: Task, quality: string, ctx: EvalContext): boolean {
  switch (quality) {
    case 'deferred':
      return isDeferred(task, ctx.nowIso);
    case 'overdue':
      return isOverdue(task, ctx.nowIso);
    case 'done':
      return task.state === 'done';
    case 'tagged':
      return task.tags.length > 0;
    case 'untagged':
      return task.tags.length === 0;
    default:
      return false;
  }
}

export function matches(query: Query, task: Task, ctx: EvalContext): boolean {
  return query.every(term => {
    const hit = term.atoms.some(atom => matchesAtom(atom, task, ctx));
    return term.negated ? !hit : hit;
  });
}

export function filterTasks<T extends {task: Task}>(
  files: readonly T[],
  query: Query,
  ctx: EvalContext,
): T[] {
  return files.filter(file => matches(query, file.task, ctx));
}

/** Build a query from explicit flags, so the CLI need not fight shell quoting. */
export function queryFromFlags(options: {
  tags?: readonly string[];
  not?: readonly string[];
  any?: readonly string[];
}): Query {
  const query: Query = [];
  for (const tag of options.tags ?? []) {
    query.push({negated: false, atoms: [{kind: 'tag', tag: normalizeTag(tag)}]});
  }
  for (const tag of options.not ?? []) {
    query.push({negated: true, atoms: [{kind: 'tag', tag: normalizeTag(tag)}]});
  }
  const any = options.any ?? [];
  if (any.length > 0) {
    query.push({
      negated: false,
      atoms: any.map(tag => ({kind: 'tag', tag: normalizeTag(tag)}) as Atom),
    });
  }
  return query;
}
