/**
 * Tags.
 *
 * Tags are discovered from usage and never registered. A registry file would be a
 * second source of truth that drifts from the files and has to be reconstructible
 * from them anyway, which makes it pointless.
 *
 * Contexts, energy levels and priorities are all just tags. That is the whole reason
 * there are no separate fields for them: one classification system, not two.
 */

/**
 * `/` is inside the charset so `work/acme` is writable today. Matching stays exact
 * for now; hierarchical prefix matching would be a purely additive change later.
 */
export const TAG_PATTERN = /^[a-z0-9][a-z0-9._/-]*$/;

/** The tag an agent looks for when deciding what it may pick up. */
export const AGENT_TAG = 'agent';

export function normalizeTag(raw: string): string {
  return raw
    .normalize('NFC')
    .trim()
    .replace(/^#/, '')
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function isValidTag(tag: string): boolean {
  return TAG_PATTERN.test(tag);
}

export interface TagNormalization {
  tags: string[];
  /** Entries that could not be made into a valid tag; reported, never silently dropped. */
  invalid: string[];
}

/** Normalise, drop duplicates, and keep the author's ordering. */
export function normalizeTags(raw: Iterable<string>): TagNormalization {
  const tags: string[] = [];
  const invalid: string[] = [];
  const seen = new Set<string>();

  for (const entry of raw) {
    const tag = normalizeTag(entry);
    if (tag.length === 0) continue;
    if (!isValidTag(tag)) {
      invalid.push(entry.trim());
      continue;
    }
    if (seen.has(tag)) continue;
    seen.add(tag);
    tags.push(tag);
  }

  return {tags, invalid};
}

export interface TagUse {
  tag: string;
  count: number;
  /** RFC3339 of the most recent task carrying it, used to break ranking ties. */
  lastUsed: string;
}

/** Build the tag index from whatever tasks are in hand. */
export function tagIndex(tasks: Iterable<{tags: string[]; created: string}>): TagUse[] {
  const counts = new Map<string, TagUse>();
  for (const task of tasks) {
    for (const tag of task.tags) {
      const existing = counts.get(tag);
      if (existing === undefined) {
        counts.set(tag, {tag, count: 1, lastUsed: task.created});
      } else {
        existing.count += 1;
        if (task.created > existing.lastUsed) existing.lastUsed = task.created;
      }
    }
  }
  return [...counts.values()].sort(
    (a, b) => b.count - a.count || a.tag.localeCompare(b.tag),
  );
}

/**
 * Rank completions for a partially-typed tag: exact prefix first, then substring,
 * then by how often the tag is used, then by recency.
 */
export function completeTag(index: TagUse[], partial: string): string[] {
  const needle = normalizeTag(partial);
  if (needle.length === 0) return index.map(u => u.tag);

  const prefix: TagUse[] = [];
  const substring: TagUse[] = [];
  for (const use of index) {
    if (use.tag.startsWith(needle)) prefix.push(use);
    else if (use.tag.includes(needle)) substring.push(use);
  }

  const byUse = (a: TagUse, b: TagUse) =>
    b.count - a.count || b.lastUsed.localeCompare(a.lastUsed) || a.tag.localeCompare(b.tag);

  return [...prefix.sort(byUse), ...substring.sort(byUse)].map(u => u.tag);
}
