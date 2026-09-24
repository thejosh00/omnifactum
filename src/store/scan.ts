/**
 * Walking the data directory and parsing what it finds.
 *
 * The scan is the whole truth. There is no index and no cache on disk, so anything an
 * agent did with `mv` and a shell append is picked up on the next read with no
 * reconciliation step. Re-scanning is cheap because a personal task system holds
 * hundreds of files, and files whose mtime and size have not moved are not re-parsed.
 */
import {randomBytes} from 'node:crypto';
import {readFileSync, readdirSync, statSync} from 'node:fs';
import {join} from 'node:path';
import {mintId} from '../core/id.ts';
import {readProject} from '../core/project.ts';
import {isDoneMonth, PROJECTS_DIR} from '../core/state.ts';
import {readTask} from '../core/task.ts';
import {PROJECT_STATES, TASK_STATES} from '../core/types.ts';
import type {
  DamagedFile,
  Project,
  ProjectState,
  Task,
  TaskState,
} from '../core/types.ts';
import {isIgnoredDirectory, isReadableEntry, stemOf} from './paths.ts';

/** A task as it was found on disk. Only `omni import` reads files now. */
export interface DiskTaskFile {
  task: Task;
  path: string;
  stem: string;
  mtimeMs: number;
  size: number;
  raw: string;
}

export interface DiskProjectFile {
  project: Project;
  path: string;
  stem: string;
  mtimeMs: number;
  size: number;
  raw: string;
}

export interface ScanResult {
  tasks: DiskTaskFile[];
  projects: DiskProjectFile[];
  damaged: DamagedFile[];
}

export interface ScanOptions {
  /** Files already parsed, keyed by path, reused when mtime and size have not moved. */
  previous?: Map<string, DiskTaskFile>;
  previousProjects?: Map<string, DiskProjectFile>;
  nowIso?: string;
  /** Injected so tests are deterministic. */
  mint?: () => string;
}

function defaultMint(): string {
  return mintId(Date.now(), randomBytes(4));
}

interface Candidate<S> {
  path: string;
  state: S;
  month?: string;
}

function markdownIn(dir: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  return entries.filter(isReadableEntry).map(name => join(dir, name));
}

function subdirectories(dir: string): string[] {
  try {
    return readdirSync(dir, {withFileTypes: true})
      .filter(entry => entry.isDirectory() && !isIgnoredDirectory(entry.name))
      .map(entry => entry.name);
  } catch {
    return [];
  }
}

/** Files inside `<root>/done/<month>/`, ignoring any folder that is not a month. */
function monthBuckets<S>(root: string, state: S): Array<Candidate<S>> {
  const found: Array<Candidate<S>> = [];
  for (const month of subdirectories(join(root, 'done'))) {
    if (!isDoneMonth(month)) continue;
    for (const path of markdownIn(join(root, 'done', month))) {
      found.push({path, state, month});
    }
  }
  return found;
}

function taskCandidates(dataDir: string): Array<Candidate<TaskState>> {
  const found: Array<Candidate<TaskState>> = [];
  for (const state of TASK_STATES) {
    if (state === 'done') continue;
    for (const path of markdownIn(join(dataDir, state))) found.push({path, state});
  }
  found.push(...monthBuckets<TaskState>(dataDir, 'done'));
  return found;
}

function projectCandidates(dataDir: string): Array<Candidate<ProjectState>> {
  const root = join(dataDir, PROJECTS_DIR);
  const found: Array<Candidate<ProjectState>> = [];
  for (const state of PROJECT_STATES) {
    if (state === 'done') continue;
    for (const path of markdownIn(join(root, state))) found.push({path, state});
  }
  found.push(...monthBuckets<ProjectState>(root, 'done'));
  return found;
}

interface Parsed<T> {
  entries: T[];
  damaged: DamagedFile[];
}

/** Shared walk: stat, reuse an unchanged parse, otherwise read and hand to core. */
function parseAll<S, T extends {path: string; mtimeMs: number; size: number}>(
  candidates: ReadonlyArray<Candidate<S>>,
  previous: Map<string, T> | undefined,
  stateOf: (entry: T) => S,
  parse: (
    raw: string,
    candidate: Candidate<S>,
    stat: {birthtimeMs: number; mtimeMs: number; size: number},
  ) => {kind: 'ok'; entry: T} | {kind: 'damaged'; reason: string},
): Parsed<T> {
  const entries: T[] = [];
  const damaged: DamagedFile[] = [];

  for (const candidate of candidates) {
    let stat;
    try {
      stat = statSync(candidate.path);
    } catch {
      continue; // Vanished between listing and reading, which is normal.
    }

    const cached = previous?.get(candidate.path);
    if (
      cached !== undefined &&
      cached.mtimeMs === stat.mtimeMs &&
      cached.size === stat.size &&
      stateOf(cached) === candidate.state
    ) {
      entries.push(cached);
      continue;
    }

    const stem = stemOf(candidate.path);
    let raw: string;
    try {
      raw = readFileSync(candidate.path, 'utf8');
    } catch (error) {
      damaged.push({
        path: candidate.path,
        stem,
        reason: error instanceof Error ? error.message : 'could not be read',
      });
      continue;
    }

    const result = parse(raw, candidate, {
      birthtimeMs: stat.birthtimeMs,
      mtimeMs: stat.mtimeMs,
      size: stat.size,
    });
    if (result.kind === 'damaged') {
      damaged.push({path: candidate.path, stem, reason: result.reason});
      continue;
    }
    entries.push(result.entry);
  }

  return {entries, damaged};
}

export function scan(dataDir: string, options: ScanOptions = {}): ScanResult {
  const mint = options.mint ?? defaultMint;
  const nowIso = options.nowIso ?? new Date().toISOString();

  const tasks = parseAll<TaskState, DiskTaskFile>(
    taskCandidates(dataDir),
    options.previous,
    file => file.task.state,
    (raw, candidate, stat) => {
      const stem = stemOf(candidate.path);
      const result = readTask(raw, {
        state: candidate.state,
        ...(candidate.month === undefined ? {} : {month: candidate.month}),
        stem,
        birthtimeMs: stat.birthtimeMs,
        mtimeMs: stat.mtimeMs,
        nowIso,
        mintId: mint,
      });
      if (result.kind === 'damaged') return result;
      return {
        kind: 'ok',
        entry: {
          task: result.task,
          path: candidate.path,
          stem,
          mtimeMs: stat.mtimeMs,
          size: stat.size,
          raw,
        },
      };
    },
  );

  const projects = parseAll<ProjectState, DiskProjectFile>(
    projectCandidates(dataDir),
    options.previousProjects,
    file => file.project.state,
    (raw, candidate, stat) => {
      const stem = stemOf(candidate.path);
      const result = readProject(raw, {
        state: candidate.state,
        ...(candidate.month === undefined ? {} : {month: candidate.month}),
        stem,
        birthtimeMs: stat.birthtimeMs,
        mtimeMs: stat.mtimeMs,
        mintId: mint,
      });
      if (result.kind === 'damaged') return result;
      return {
        kind: 'ok',
        entry: {
          project: result.project,
          path: candidate.path,
          stem,
          mtimeMs: stat.mtimeMs,
          size: stat.size,
          raw,
        },
      };
    },
  );

  // Stable ordering by id, which is creation order, so output never jitters.
  return {
    tasks: tasks.entries.sort((a, b) => a.task.id.localeCompare(b.task.id)),
    projects: projects.entries.sort((a, b) => a.project.id.localeCompare(b.project.id)),
    damaged: [...tasks.damaged, ...projects.damaged].sort((a, b) => a.path.localeCompare(b.path)),
  };
}

/** Tasks only, for callers that do not care about projects. */
export function scanTasks(
  dataDir: string,
  options: ScanOptions = {},
): {tasks: DiskTaskFile[]; damaged: DamagedFile[]} {
  const {tasks, damaged} = scan(dataDir, options);
  return {tasks, damaged};
}
