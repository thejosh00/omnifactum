/**
 * Reading and writing a project file, and resolving what a task's `project:` field
 * points at.
 *
 * Projects follow exactly the same rules as tasks: the directory is the state, the
 * filename is a label rather than an identity, an unmodified file round-trips byte for
 * byte, and a file missing something is still a project. One rule, not two.
 *
 * The one field that is genuinely required is `outcome` — the GTD statement of what
 * done looks like. A project without one is the precise thing GTD exists to prevent, so
 * a missing outcome is a finding rather than something to invent.
 */
import {localDate} from './time.ts';
import {joinFrontmatter, splitFrontmatter} from './frontmatter.ts';
import {appendLogEntry, joinBodyAndLog, splitBodyAndLog} from './log.ts';
import {ACTOR_USER} from './mutation.ts';
import {normalizeId} from './id.ts';
import {foldName, slugify} from './slug.ts';
import {doneMonth} from './state.ts';
import {normalizeTags} from './tags.ts';
import {titleFromStem} from './task.ts';
import {FrontmatterDoc} from './yamlDoc.ts';
import type {LogEntry, Project, ProjectFile, ProjectState, Repair} from './types.ts';

export const KNOWN_PROJECT_KEYS = [
  'id',
  'title',
  'outcome',
  'created',
  'tags',
  'due',
  'reviewed',
  'aliases',
  'done',
] as const;

export interface ProjectReadContext {
  state: ProjectState;
  month?: string;
  stem: string;
  birthtimeMs: number;
  mtimeMs: number;
  mintId: () => string;
}

export type ProjectReadResult =
  | {kind: 'ok'; project: Project; needsHealing: boolean}
  | {kind: 'damaged'; reason: string};

function isoFrom(ms: number): string {
  const at = new Date(ms);
  return Number.isNaN(at.getTime()) ? new Date(0).toISOString() : at.toISOString();
}

export function readProject(raw: string, ctx: ProjectReadContext): ProjectReadResult {
  const split = splitFrontmatter(raw);
  const fm = split.hasFrontmatter ? FrontmatterDoc.parse(split.frontmatter) : FrontmatterDoc.empty();

  if (!fm.ok) {
    return {kind: 'damaged', reason: `frontmatter did not parse: ${fm.errors[0] ?? 'unknown error'}`};
  }

  const repairs: Repair[] = [];
  const {body, log} = splitBodyAndLog(split.body);

  if (!split.hasFrontmatter) {
    repairs.push({kind: 'unparsable-frontmatter', detail: 'the file had no frontmatter block'});
  }

  const rawId = fm.getString('id');
  let id = rawId === undefined ? undefined : normalizeId(rawId);
  if (id === undefined) {
    id = ctx.mintId();
    repairs.push({
      kind: 'missing-id',
      detail: rawId === undefined ? 'no id; minted one' : `id "${rawId}" was not valid; minted one`,
    });
  }

  let title = fm.getString('title');
  if (title === undefined) {
    title = titleFromStem(ctx.stem);
    repairs.push({kind: 'missing-title', detail: `no title; used "${title}"`});
  }

  let created = fm.getString('created');
  if (created === undefined) {
    created = isoFrom(ctx.birthtimeMs);
    repairs.push({kind: 'missing-created', detail: "no created date; used the file's birth time"});
  }

  // Deliberately not invented. "What does done look like" is the whole point of a
  // project, and guessing at it would defeat the stalled-project check as well.
  const outcome = fm.getString('outcome');
  if (outcome === undefined) {
    repairs.push({
      kind: 'missing-outcome',
      detail: 'no outcome; a project needs a statement of what done looks like',
    });
  }

  const tagRead = fm.getTags('tags');
  const {tags, invalid} = normalizeTags(tagRead.values);
  for (const coerced of tagRead.coerced) {
    repairs.push({kind: 'coerced-tag', detail: `tag "${coerced}" reads as a non-string in YAML`});
  }
  for (const bad of invalid) {
    repairs.push({kind: 'invalid-tag', detail: `tag "${bad}" is not a usable tag name`});
  }

  let done = fm.getString('done');
  if (ctx.state === 'done') {
    if (done === undefined) {
      done = isoFrom(ctx.mtimeMs);
      repairs.push({kind: 'missing-done', detail: "completed but had no done date; used the file's modified time"});
    } else if (ctx.month !== undefined) {
      let actual: string | undefined;
      try {
        actual = doneMonth(done);
      } catch {
        actual = undefined;
      }
      if (actual !== undefined && actual !== ctx.month) {
        repairs.push({
          kind: 'done-month-mismatch',
          detail: `filed under projects/done/${ctx.month} but completed in ${actual}`,
        });
      }
    }
  }

  const project: Project = {
    id,
    title,
    outcome: outcome ?? '',
    created,
    state: ctx.state,
    tags,
    aliases: fm.getTags('aliases').values,
    body,
    log,
    repairs,
  };

  const due = fm.getString('due');
  if (due !== undefined) project.due = due;
  const reviewed = fm.getString('reviewed');
  if (reviewed !== undefined) project.reviewed = reviewed;
  if (done !== undefined) project.done = done;

  return {kind: 'ok', project, needsHealing: repairs.length > 0};
}

function logsEqual(a: LogEntry[], b: LogEntry[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((entry, i) => {
    const other = b[i]!;
    if (entry.parsed !== other.parsed) return false;
    if (!entry.parsed) return entry.raw === other.raw;
    return entry.at === other.at && entry.actor === other.actor && entry.text === other.text;
  });
}

/** Pass an empty string as `originalRaw` to write a brand-new project. */
export function writeProject(project: Project, originalRaw: string): string {
  const split = splitFrontmatter(originalRaw);
  const fm = split.hasFrontmatter ? FrontmatterDoc.parse(split.frontmatter) : FrontmatterDoc.empty();

  if (!fm.ok) {
    throw new Error(`refusing to write over frontmatter that did not parse: ${fm.errors[0]}`);
  }

  fm.set('id', project.id);
  fm.set('title', project.title);
  fm.set('outcome', project.outcome.length > 0 ? project.outcome : undefined);
  fm.set('created', project.created);
  fm.setTags('tags', project.tags);
  fm.set('due', project.due);
  fm.set('reviewed', project.reviewed);
  fm.setTags('aliases', project.aliases);
  fm.set('done', project.done);

  const original = splitBodyAndLog(split.body);
  const unchanged = original.body === project.body && logsEqual(original.log, project.log);
  const body = unchanged ? split.body : renderBody(project);

  return joinFrontmatter({...split, hasFrontmatter: true, frontmatter: fm.toText(), body});
}

function renderBody(project: Project): string {
  const rendered = joinBodyAndLog(project.body, project.log);
  return rendered.startsWith('\n') || rendered.length === 0 ? rendered : `\n${rendered}`;
}

/**
 * How a task's `project:` field is matched to a project.
 *
 * The field holds a filename stem, because readability is the whole point of this
 * format and an identifier there would be unreadable. The cost is that a hand-rename
 * breaks the link, so resolution is a documented cascade rather than a single lookup,
 * and each step is a real recovery path:
 *
 *   1. the stem, which is the normal case
 *   2. the id, for anyone who prefers to be explicit
 *   3. the slug of the title, which survives a file being renamed to match its title
 *   4. an alias, which is how the app's own renames stay linked
 *   5. an unambiguous id prefix
 */
export type ProjectMatch =
  | {kind: 'ok'; project: ProjectFile; via: 'stem' | 'id' | 'title' | 'alias' | 'prefix'}
  | {kind: 'none'}
  | {kind: 'ambiguous'; candidates: ProjectFile[]};

export function resolveProjectRef(
  projects: readonly ProjectFile[],
  ref: string,
): ProjectMatch {
  const needle = ref.trim();
  if (needle.length === 0) return {kind: 'none'};
  const folded = foldName(needle);

  const byStem = projects.filter(p => foldName(p.stem) === folded);
  if (byStem.length === 1) return {kind: 'ok', project: byStem[0]!, via: 'stem'};
  if (byStem.length > 1) return {kind: 'ambiguous', candidates: byStem};

  const normalized = normalizeId(needle);
  if (normalized !== undefined) {
    const byId = projects.filter(p => p.project.id === normalized);
    if (byId.length === 1) return {kind: 'ok', project: byId[0]!, via: 'id'};
    if (byId.length > 1) return {kind: 'ambiguous', candidates: byId};
  }

  // Both sides slugified, so "Renovate the kitchen" as typed matches its title.
  const typedSlug = foldName(slugify(needle));
  const byTitle = projects.filter(p => foldName(slugify(p.project.title)) === typedSlug);
  if (byTitle.length === 1) return {kind: 'ok', project: byTitle[0]!, via: 'title'};
  if (byTitle.length > 1) return {kind: 'ambiguous', candidates: byTitle};

  const byAlias = projects.filter(p => p.project.aliases.some(a => foldName(a) === folded));
  if (byAlias.length === 1) return {kind: 'ok', project: byAlias[0]!, via: 'alias'};
  if (byAlias.length > 1) return {kind: 'ambiguous', candidates: byAlias};

  const lower = needle.toLowerCase();
  const byPrefix = projects.filter(p => p.project.id.startsWith(lower));
  if (byPrefix.length === 1) return {kind: 'ok', project: byPrefix[0]!, via: 'prefix'};
  if (byPrefix.length > 1) return {kind: 'ambiguous', candidates: byPrefix};

  return {kind: 'none'};
}

export interface NewProjectInput {
  id: string;
  title: string;
  outcome: string;
  nowIso: string;
  state?: ProjectState;
  tags?: Iterable<string>;
  due?: string;
  body?: string;
  /**
   * Start it without an outcome. Only for a project that came into being as a side
   * effect — named in a capture, or clarified out of an inbox item — where stopping to
   * ask would lose the item. It then shows as "no outcome yet" and the weekly review
   * asks for one, the same as a project that lost its outcome some other way.
   */
  outcomeLater?: boolean;
}

export function planNewProject(input: NewProjectInput): Project {
  const title = input.title.trim();
  if (title.length === 0) throw new Error('a project needs a title');

  const outcome = input.outcome.trim();
  if (outcome.length === 0 && input.outcomeLater !== true) {
    throw new Error('a project needs an outcome: what does done look like?');
  }

  const project: Project = {
    id: input.id,
    title,
    outcome,
    created: input.nowIso,
    state: input.state ?? 'active',
    tags: normalizeTags(input.tags ?? []).tags,
    aliases: [],
    body: input.body ?? '',
    log: [],
    repairs: [],
  };
  if (input.due !== undefined) project.due = input.due;
  return project;
}

export interface ProjectChange {
  nowIso: string;
  actor?: string;
  note?: string;
}

function withLog(project: Project, ctx: ProjectChange, text: string): Project {
  return {
    ...project,
    log: appendLogEntry(project.log, ctx.nowIso, ctx.actor ?? ACTOR_USER, text),
  };
}

export function planCompleteProject(project: Project, ctx: ProjectChange): Project {
  const note = ctx.note?.trim();
  const done: Project = {...project, state: 'done', done: ctx.nowIso};
  return withLog(done, ctx, note !== undefined && note.length > 0 ? note : 'Outcome reached.');
}

export function planMoveProject(
  project: Project,
  to: ProjectState,
  ctx: ProjectChange,
): Project {
  if (to === 'done') return planCompleteProject(project, ctx);

  const moved: Project = {...project, state: to};
  delete moved.done;

  const note = ctx.note?.trim();
  return withLog(moved, ctx, note !== undefined && note.length > 0 ? note : `Moved to ${to}.`);
}

export function planSetOutcome(project: Project, outcome: string): Project {
  const trimmed = outcome.trim();
  if (trimmed.length === 0) {
    throw new Error('a project needs an outcome: what does done look like?');
  }
  return {...project, outcome: trimmed};
}

/** Stamp the local date of a review, which is what `omni weekly --record` records. */
export function planReviewed(project: Project, nowIso: string): Project {
  return {...project, reviewed: localDate(nowIso)};
}

/**
 * Rename a project, recording the old stem as an alias so the tasks that still point
 * at it keep resolving even before their files are rewritten.
 */
export function planRenameProject(project: Project, previousStem: string, title: string): Project {
  const trimmed = title.trim();
  if (trimmed.length === 0) throw new Error('a project needs a title');

  const aliases = project.aliases.includes(previousStem)
    ? project.aliases
    : [...project.aliases, previousStem];

  return {...project, title: trimmed, aliases};
}
