/**
 * Quick capture: turning one typed line into a task.
 *
 * Capture has to be faster than thinking, or things do not get written down. So the
 * line accepts inline `#tags` and a `+project`, strips them out, and leaves the rest as
 * the title. Pure, so every shape below is a cheap test rather than something to
 * discover by typing at the real interface.
 */
import {normalizeTag, normalizeTags} from './tags.ts';

export interface Captured {
  title: string;
  tags: string[];
  project?: string;
}

const TAG_TOKEN = /(^|\s)#([^\s#]+)/g;
const PROJECT_TOKEN = /(^|\s)\+([^\s+]+)/g;

export function parseCapture(line: string): Captured {
  const tags: string[] = [];
  let project: string | undefined;

  let rest = line.replace(TAG_TOKEN, (_match, lead: string, tag: string) => {
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

  const captured: Captured = {
    title: rest.replace(/\s+/g, ' ').trim(),
    tags: normalizeTags(tags).tags,
  };
  if (project !== undefined) captured.project = project;
  return captured;
}

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
