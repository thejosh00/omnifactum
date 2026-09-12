/**
 * Reading and writing a task file.
 *
 * Two principles run through this module.
 *
 * **Required-ness applies to what `omni` writes, never to what it will read.** A file
 * missing an id, a title, or a created date is still a task. The reader backfills what
 * it can and reports what it did, which is what makes "an agent can just write a file"
 * actually true rather than aspirational.
 *
 * **An unmodified task round-trips byte for byte.** `writeTask` is handed the original
 * bytes and reuses them for any part that did not change: the frontmatter comes back
 * verbatim unless a field was edited, and the body comes back verbatim unless the prose
 * or the log changed. A human's formatting survives being opened.
 */
import {joinFrontmatter, splitFrontmatter} from './frontmatter.ts';
import {joinBodyAndLog, splitBodyAndLog} from './log.ts';
import {normalizeId} from './id.ts';
import {doneMonth} from './state.ts';
import {normalizeTags} from './tags.ts';
import {FrontmatterDoc} from './yamlDoc.ts';
import type {LogEntry, Repair, Task, TaskState} from './types.ts';

/** Frontmatter keys the app understands. Anything else is preserved untouched. */
export const KNOWN_TASK_KEYS = [
  'id',
  'title',
  'created',
  'tags',
  'project',
  'due',
  'defer',
  'waiting_on',
  'asked',
  'done',
] as const;

export interface TaskReadContext {
  /** From the directory, which is the only thing that defines state. */
  state: TaskState;
  /** The month bucket, when the task is in `done/`. */
  month?: string;
  stem: string;
  birthtimeMs: number;
  mtimeMs: number;
  nowIso: string;
  mintId: () => string;
}

export type TaskReadResult =
  | {kind: 'ok'; task: Task; needsHealing: boolean}
  | {kind: 'damaged'; reason: string};

function isoFrom(ms: number): string {
  const at = new Date(ms);
  return Number.isNaN(at.getTime()) ? new Date(0).toISOString() : at.toISOString();
}

/** Turn a filename stem into a passable title, for a file that never had one. */
export function titleFromStem(stem: string): string {
  const words = stem.replace(/[-_]+/g, ' ').trim();
  if (words.length === 0) return stem;
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function firstHeading(body: string): string | undefined {
  const match = /^#{1,6}\s+(.+?)\s*$/m.exec(body);
  const heading = match?.[1]?.trim();
  if (heading === undefined || heading.length === 0) return undefined;
  // `## Log` is structure, not a title.
  return /^log$/i.test(heading) ? undefined : heading;
}

export function readTask(raw: string, ctx: TaskReadContext): TaskReadResult {
  const split = splitFrontmatter(raw);
  const fm = split.hasFrontmatter ? FrontmatterDoc.parse(split.frontmatter) : FrontmatterDoc.empty();

  if (!fm.ok) {
    return {
      kind: 'damaged',
      reason: `frontmatter did not parse: ${fm.errors[0] ?? 'unknown error'}`,
    };
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
    title = firstHeading(split.body) ?? titleFromStem(ctx.stem);
    repairs.push({kind: 'missing-title', detail: `no title; used "${title}"`});
  }

  let created = fm.getString('created');
  if (created === undefined) {
    created = isoFrom(ctx.birthtimeMs);
    repairs.push({kind: 'missing-created', detail: `no created date; used the file's birth time`});
  }

  const tagRead = fm.getTags('tags');
  const {tags, invalid} = normalizeTags(tagRead.values);
  for (const coerced of tagRead.coerced) {
    repairs.push({
      kind: 'coerced-tag',
      detail: `tag "${coerced}" is not quoted and YAML reads it as a non-string`,
    });
  }
  for (const bad of invalid) {
    repairs.push({kind: 'invalid-tag', detail: `tag "${bad}" is not a usable tag name`});
  }

  const defer = fm.getString('defer');
  if (defer !== undefined && ctx.state !== 'someday') {
    // A deferred item in `next/` would be work that is not actually ready, and an agent
    // reading that directory literally would pick it up. Keeping `defer` to `someday/`
    // is what lets `next/` be taken at face value.
    repairs.push({
      kind: 'defer-outside-someday',
      detail: `defer is only meaningful in someday/, but this task is in ${ctx.state}/`,
    });
  }

  let done = fm.getString('done');
  if (ctx.state === 'done') {
    if (done === undefined) {
      done = isoFrom(ctx.mtimeMs);
      repairs.push({
        kind: 'missing-done',
        detail: "completed but had no done date; used the file's modified time",
      });
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
          detail: `filed under done/${ctx.month} but completed in ${actual}`,
        });
      }
    }
  }

  const task: Task = {
    id,
    title,
    created,
    state: ctx.state,
    tags,
    body,
    log,
    repairs,
  };

  const project = fm.getString('project');
  if (project !== undefined) task.project = project;
  const due = fm.getString('due');
  if (due !== undefined) task.due = due;
  if (defer !== undefined) task.defer = defer;
  const waitingOn = fm.getString('waiting_on');
  if (waitingOn !== undefined) task.waitingOn = waitingOn;
  const asked = fm.getString('asked');
  if (asked !== undefined) task.asked = asked;
  if (done !== undefined) task.done = done;

  return {kind: 'ok', task, needsHealing: repairs.length > 0};
}

function logsEqual(a: LogEntry[], b: LogEntry[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((entry, i) => {
    const other = b[i]!;
    if (entry.parsed !== other.parsed) return false;
    // A line we did not understand is compared by its exact text, since that is what
    // gets written back. A line we did understand is compared by what it means.
    if (!entry.parsed) return entry.raw === other.raw;
    return entry.at === other.at && entry.actor === other.actor && entry.text === other.text;
  });
}

/**
 * Serialise a task back to file text, reusing `originalRaw` for everything that did
 * not change. Passing a freshly-read, unmodified task returns the original bytes.
 *
 * Pass an empty string as `originalRaw` to write a brand-new file.
 */
export function writeTask(task: Task, originalRaw: string): string {
  const split = splitFrontmatter(originalRaw);
  const fm = split.hasFrontmatter ? FrontmatterDoc.parse(split.frontmatter) : FrontmatterDoc.empty();

  if (!fm.ok) {
    throw new Error(`refusing to write over frontmatter that did not parse: ${fm.errors[0]}`);
  }

  fm.set('id', task.id);
  fm.set('title', task.title);
  fm.set('created', task.created);
  fm.setTags('tags', task.tags);
  fm.set('project', task.project);
  fm.set('due', task.due);
  fm.set('defer', task.defer);
  fm.set('waiting_on', task.waitingOn);
  fm.set('asked', task.asked);
  fm.set('done', task.done);

  const original = splitBodyAndLog(split.body);
  const bodyUnchanged = original.body === task.body && logsEqual(original.log, task.log);
  const body = bodyUnchanged ? split.body : renderBody(task);

  return joinFrontmatter({
    ...split,
    hasFrontmatter: true,
    frontmatter: fm.toText(),
    body,
  });
}

function renderBody(task: Task): string {
  const rendered = joinBodyAndLog(task.body, task.log);
  // Keep one blank line between the frontmatter and the prose, which is how the
  // approved example reads.
  return rendered.startsWith('\n') || rendered.length === 0 ? rendered : `\n${rendered}`;
}
