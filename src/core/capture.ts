/**
 * Quick capture: turning one typed line into a task.
 *
 * Capture has to be faster than thinking, or things do not get written down. So the
 * line accepts a few tokens, strips them out, and leaves the rest as the title:
 *
 *   #tag            a tag, as many as you like
 *   +project        the project, the first one only
 *   >next           the list to file it in: inbox, next, waiting, someday or done
 *   >waiting:Sam    waiting, and on whom
 *   due:fri         a deadline: today, tomorrow, a weekday, +3d, +2w, +1m or 2026-10-15
 *   defer:+2w       hidden until then, which means someday
 *
 * A token is only taken when it is exactly one of these, so `A > B` and `ratio 3:2` stay
 * in the title. One that looks meant but cannot be read — `due:someday`, `>later` — is a
 * problem to show, never something to guess at or quietly drop into the title.
 *
 * Pure, so every shape below is a cheap test rather than something to discover by
 * typing at the real interface.
 */
import {resolveDate} from './filter.ts';
import {normalizeTag, normalizeTags} from './tags.ts';
import type {TaskState} from './types.ts';

/** The lists a capture can go straight into. `review` is where agents hand work back, not a place to file things. */
export const CAPTURE_LISTS = ['inbox', 'next', 'waiting', 'someday', 'done'] as const;
export type CaptureList = (typeof CAPTURE_LISTS)[number];

export interface Captured {
  title: string;
  tags: string[];
  project?: string;
  /** Absent means the inbox, where anything captured without a decision belongs. */
  state?: TaskState;
  waitingOn?: string;
  /** Local `YYYY-MM-DD`. */
  due?: string;
  defer?: string;
  /** What could not be read. A capture with problems should not be filed. */
  problems?: string[];
}

const TAG_TOKEN = /(^|\s)#([^\s#]+)/g;
const PROJECT_TOKEN = /(^|\s)\+([^\s+]+)/g;
const LIST_TOKEN = /(^|\s)>([a-z]+)(?::(\S+))?(?=\s|$)/gi;
const DATE_TOKEN = /(^|\s)(due|defer):(\S*)(?=\s|$)/gi;

/**
 * Read a capture line. `nowIso` is needed to turn `due:fri` into a date; without it,
 * dates are reported as problems rather than guessed.
 */
export function parseCapture(line: string, nowIso?: string): Captured {
  const tags: string[] = [];
  const problems: string[] = [];
  let project: string | undefined;
  let state: TaskState | undefined;
  let waitingOn: string | undefined;
  let due: string | undefined;
  let defer: string | undefined;

  let rest = line.replace(LIST_TOKEN, (match, lead: string, name: string, extra: string | undefined) => {
    const list = name.toLowerCase();
    if (!(CAPTURE_LISTS as readonly string[]).includes(list)) {
      // `>foo` is only a mistake if it could plausibly have been meant as a list.
      if (list.length >= 3 && CAPTURE_LISTS.some(known => known.startsWith(list))) {
        problems.push(`">${name}" — did you mean ${CAPTURE_LISTS.filter(k => k.startsWith(list)).map(k => `>${k}`).join(' or ')}?`);
      }
      return match;
    }
    if (extra !== undefined && list !== 'waiting') {
      problems.push(`only >waiting takes a name: ">waiting:${extra}"`);
      return lead;
    }
    if (state !== undefined && state !== list) problems.push(`two lists given: >${state} and >${list}`);
    state = list as TaskState;
    if (extra !== undefined) waitingOn = extra;
    return lead;
  });

  rest = rest.replace(DATE_TOKEN, (_match, lead: string, kind: string, value: string) => {
    const field = kind.toLowerCase() as 'due' | 'defer';
    const date = nowIso === undefined || value.length === 0 ? undefined : resolveDate(value, nowIso);
    if (date === undefined) {
      problems.push(
        value.length === 0 ? `${field}: needs a date` : `"${value}" is not a date — try tomorrow, fri, +3d or 2026-10-15`,
      );
    } else if (field === 'due') due = date;
    else defer = date;
    return lead;
  });

  rest = rest.replace(TAG_TOKEN, (_match, lead: string, tag: string) => {
    const normalized = normalizeTag(tag);
    if (normalized.length > 0) tags.push(normalized);
    return lead;
  });

  rest = rest.replace(PROJECT_TOKEN, (match, lead: string, ref: string) => {
    // Only the first +project counts; a later one is probably part of the sentence.
    if (project !== undefined) return match;
    project = ref;
    return lead;
  });

  // A defer date means "not now", which is what someday is for.
  if (defer !== undefined) {
    if (state === undefined) state = 'someday';
    else if (state !== 'someday') problems.push(`a defer date only goes with >someday, not >${state}`);
  }

  const captured: Captured = {
    title: rest.replace(/\s+/g, ' ').trim(),
    tags: normalizeTags(tags).tags,
  };
  if (project !== undefined) captured.project = project;
  if (state !== undefined) captured.state = state;
  if (waitingOn !== undefined) captured.waitingOn = waitingOn;
  if (due !== undefined) captured.due = due;
  if (defer !== undefined) captured.defer = defer;
  if (captured.title.length === 0 && line.trim().length > 0) problems.push('there is no title left once the tokens are taken out');
  if (problems.length > 0) captured.problems = problems;
  return captured;
}

/** The word being typed at the end of a line, and what kind of completion it wants. */
export type CompletionKind = 'tag' | 'project' | 'list' | 'date';

export interface Completing {
  kind: CompletionKind;
  /** What has been typed of it so far, after its marker. */
  partial: string;
  /** Where the replaceable part starts in the line. */
  start: number;
}

/**
 * What the last word of a capture line is asking to be completed as, if anything.
 * `#ca` wants a tag, `+kit` a project, `>ne` a list, `due:fr` a date.
 */
export function completing(line: string): Completing | undefined {
  const match = /(^|\s)(#|\+|>|due:|defer:)([^\s]*)$/i.exec(line);
  if (match === null) return undefined;
  const marker = match[2]!.toLowerCase();
  const partial = match[3]!;
  const start = line.length - partial.length;
  const kind: CompletionKind = marker === '#' ? 'tag' : marker === '+' ? 'project' : marker === '>' ? 'list' : 'date';
  return {kind, partial, start};
}

/** Date words worth offering, in the order people reach for them. */
export const DATE_WORDS = ['today', 'tomorrow', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun', '+1w', '+2w', '+1m'];

/** The inverse, for pre-filling the tag editor with what a task already has. */
export function formatTags(tags: readonly string[]): string {
  return tags.map(tag => `#${tag}`).join(' ');
}

/**
 * Read a line of tag edits: bare or `#`-prefixed tags to set, `-tag` to remove. With
 * no removals it replaces the list outright, which is what "edit tags" should mean.
 */
export interface TagEdit {
  set: string[];
  remove: string[];
}

export function parseTagEdit(line: string): TagEdit {
  const set: string[] = [];
  const remove: string[] = [];

  for (const token of line.split(/\s+/).filter(t => t.length > 0)) {
    if (token.startsWith('-')) {
      const tag = normalizeTag(token.slice(1));
      if (tag.length > 0) remove.push(tag);
      continue;
    }
    const tag = normalizeTag(token);
    if (tag.length > 0) set.push(tag);
  }

  return {set: normalizeTags(set).tags, remove: normalizeTags(remove).tags};
}

/** Apply a tag edit to the tags a task already has. */
export function applyTagEdit(current: readonly string[], edit: TagEdit): string[] {
  const removals = new Set(edit.remove);
  // A line with only removals trims the existing list; anything else replaces it.
  const base = edit.set.length > 0 ? edit.set : [...current];
  return normalizeTags(base.filter(tag => !removals.has(tag))).tags;
}

/** Complete the word under the cursor from the offered list, longest common prefix. */
export function completeLastWord(value: string, completions: readonly string[]): string | undefined {
  const match = /(^|\s)(\S*)$/.exec(value);
  if (match === null) return undefined;

  const partial = match[2] ?? '';
  const head = value.slice(0, value.length - partial.length);

  const candidates = completions.filter(option => option.startsWith(partial));
  if (candidates.length === 0) return undefined;
  if (candidates.length === 1) return `${head}${candidates[0]!} `;

  const shared = commonPrefix(candidates);
  return shared.length > partial.length ? `${head}${shared}` : undefined;
}

function commonPrefix(values: readonly string[]): string {
  if (values.length === 0) return '';
  let prefix = values[0]!;
  for (const value of values.slice(1)) {
    let i = 0;
    while (i < prefix.length && i < value.length && prefix[i] === value[i]) i++;
    prefix = prefix.slice(0, i);
  }
  return prefix;
}
