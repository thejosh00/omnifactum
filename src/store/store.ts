/**
 * The bridge between pure core values and the filesystem.
 *
 * The store contains no decisions. Core works out what a task should become; this
 * carries the result to a file, in the right order and without clobbering anyone.
 */
import {randomBytes} from 'node:crypto';
import {mkdirSync, readFileSync, readdirSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {mintId} from '../core/id.ts';
import {nowIso} from '../core/time.ts';
import {isAppAuthoredStem, stemFor, uniqueStem} from '../core/slug.ts';
import {buildSnapshot} from '../core/snapshot.ts';
import {baseDirectories, projectDir, taskDir} from '../core/state.ts';
import {writeTask} from '../core/task.ts';
import {writeProject} from '../core/project.ts';
import type {Snapshot} from '../core/snapshot.ts';
import type {Project, ProjectFile, Task, TaskFile} from '../core/types.ts';
import {MARKDOWN_EXTENSION, stemOf} from './paths.ts';
import {scan} from './scan.ts';
import {withLock, type LockOptions} from './lock.ts';
import {atomicMove, atomicWrite, deleteFile, stampOf} from './write.ts';

/** What a locked mutation did. */
export type Updated<T> =
  | {kind: 'ok'; file: T}
  | {kind: 'not-found'}
  | {kind: 'failed'; reason: string};

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export interface StoreOptions {
  /** Injected so tests are deterministic; both default to the real clock and RNG. */
  now?: () => string;
  mint?: () => string;
}

export class Store {
  private cache = new Map<string, TaskFile>();
  private projectCache = new Map<string, ProjectFile>();

  constructor(
    readonly dataDir: string,
    private readonly options: StoreOptions = {},
  ) {}

  private now(): string {
    return this.options.now?.() ?? nowIso();
  }

  private mint(): string {
    return this.options.mint?.() ?? mintId(Date.now(), randomBytes(4));
  }

  /** A fresh id, for a new task or for resolving a duplicate. */
  mintId(): string {
    return this.mint();
  }

  /** Create the directory layout. Safe to run repeatedly. */
  ensureLayout(): void {
    for (const relative of baseDirectories()) {
      mkdirSync(join(this.dataDir, relative), {recursive: true});
    }
  }

  /** Read the whole world. Cheap enough to do after every mutation. */
  load(): Snapshot {
    const {tasks, projects, damaged} = scan(this.dataDir, {
      previous: this.cache,
      previousProjects: this.projectCache,
      nowIso: this.now(),
      mint: () => this.mint(),
    });
    this.cache = new Map(tasks.map(file => [file.path, file]));
    this.projectCache = new Map(projects.map(file => [file.path, file]));
    return buildSnapshot(tasks, projects, damaged);
  }

  /** Forget the incremental cache. It is derived, so this is always safe. */
  invalidate(): void {
    this.cache = new Map();
    this.projectCache = new Map();
  }

  /** The stems already used in a directory, for collision resolution. */
  private takenStems(dir: string, excludePath?: string): string[] {
    try {
      return readdirSync(dir)
        .filter(name => name.toLowerCase().endsWith(MARKDOWN_EXTENSION))
        .map(name => join(dir, name))
        .filter(path => path !== excludePath)
        .map(stemOf);
    } catch {
      return [];
    }
  }

  /** Write a brand-new task. */
  create(task: Task): TaskFile {
    const dir = join(this.dataDir, taskDir(task.state, task.done));
    mkdirSync(dir, {recursive: true});

    const stem = uniqueStem(stemFor(task.title, task.id), this.takenStems(dir));
    const path = join(dir, `${stem}${MARKDOWN_EXTENSION}`);
    const raw = writeTask(task, '');
    const stamp = atomicWrite(path, raw, {expect: undefined});

    const file: TaskFile = {task, path, stem, mtimeMs: stamp.mtimeMs, size: stamp.size, raw};
    this.cache.set(path, file);
    return file;
  }

  /**
   * Apply a changed task to its file.
   *
   * Content is always written before the file moves. A crash between the two then
   * leaves a single valid file in the old directory whose log already says what
   * happened — confusing for a moment, but readable and easy to finish by hand. The
   * other order can leave one id in two directories, which breaks the rule that the
   * directory is the state and would force a dedupe rule onto every reader, agents
   * included.
   */
  apply(file: TaskFile, next: Task): TaskFile {
    const raw = writeTask(next, file.raw);

    // Step one: content, in place, refusing to overwrite someone else's edit.
    const stamp =
      raw === file.raw
        ? {mtimeMs: file.mtimeMs, size: file.size}
        : atomicWrite(file.path, raw, {expect: {mtimeMs: file.mtimeMs, size: file.size}});

    // Step two: relocate, if the state or the title calls for it.
    const targetDir = join(this.dataDir, taskDir(next.state, next.done));
    const targetStem = this.stemAfterEdit(file, next, targetDir);
    const targetPath = join(targetDir, `${targetStem}${MARKDOWN_EXTENSION}`);

    let path = file.path;
    if (targetPath !== file.path) {
      path = atomicMove(file.path, targetPath);
      this.cache.delete(file.path);
    }

    const finalStamp = stampOf(path) ?? stamp;
    const updated: TaskFile = {
      task: next,
      path,
      stem: stemOf(path),
      mtimeMs: finalStamp.mtimeMs,
      size: finalStamp.size,
      raw,
    };
    this.cache.set(path, updated);
    return updated;
  }

  /**
   * The filename after an edit.
   *
   * A file keeps its name unless `omni` is the one that chose it. If a human renamed
   * the file, that name is theirs and the app never takes it back.
   */
  private stemAfterEdit(file: TaskFile, next: Task, targetDir: string): string {
    const titleChanged = next.title !== file.task.title;
    const appNamedIt = isAppAuthoredStem(file.stem, file.task.title, file.task.id);

    const desired = titleChanged && appNamedIt ? stemFor(next.title, next.id) : file.stem;
    const taken = this.takenStems(targetDir, file.path);
    return uniqueStem(desired, taken);
  }

  /** Rewrite a file whose reading had to backfill fields, so the repairs stick. */
  heal(file: TaskFile): TaskFile {
    return this.apply(file, {...file.task, repairs: []});
  }

  /**
   * Delete a task. There is no trash, by decision, so this is real. Callers confirm
   * first; the store does as it is told.
   */
  remove(file: TaskFile): void {
    deleteFile(file.path);
    this.cache.delete(file.path);
  }

  /** Write a brand-new project. */
  createProject(project: Project): ProjectFile {
    const dir = join(this.dataDir, projectDir(project.state, project.done));
    mkdirSync(dir, {recursive: true});

    const stem = uniqueStem(stemFor(project.title, project.id), this.takenStems(dir));
    const path = join(dir, `${stem}${MARKDOWN_EXTENSION}`);
    const raw = writeProject(project, '');
    const stamp = atomicWrite(path, raw, {expect: undefined});

    const file: ProjectFile = {project, path, stem, mtimeMs: stamp.mtimeMs, size: stamp.size, raw};
    this.projectCache.set(path, file);
    return file;
  }

  /** Apply a changed project to its file, content first and then any move. */
  applyProject(file: ProjectFile, next: Project): ProjectFile {
    const raw = writeProject(next, file.raw);

    const stamp =
      raw === file.raw
        ? {mtimeMs: file.mtimeMs, size: file.size}
        : atomicWrite(file.path, raw, {expect: {mtimeMs: file.mtimeMs, size: file.size}});

    const targetDir = join(this.dataDir, projectDir(next.state, next.done));
    const titleChanged = next.title !== file.project.title;
    const appNamedIt = isAppAuthoredStem(file.stem, file.project.title, file.project.id);
    const desired = titleChanged && appNamedIt ? stemFor(next.title, next.id) : file.stem;
    const targetStem = uniqueStem(desired, this.takenStems(targetDir, file.path));
    const targetPath = join(targetDir, `${targetStem}${MARKDOWN_EXTENSION}`);

    let path = file.path;
    if (targetPath !== file.path) {
      path = atomicMove(file.path, targetPath);
      this.projectCache.delete(file.path);
    }

    const finalStamp = stampOf(path) ?? stamp;
    const updated: ProjectFile = {
      project: next,
      path,
      stem: stemOf(path),
      mtimeMs: finalStamp.mtimeMs,
      size: finalStamp.size,
      raw,
    };
    this.projectCache.set(path, updated);
    return updated;
  }

  healProject(file: ProjectFile): ProjectFile {
    return this.applyProject(file, {...file.project, repairs: []});
  }

  removeProject(file: ProjectFile): void {
    deleteFile(file.path);
    this.projectCache.delete(file.path);
  }

  /**
   * The safe way to change a task, and the one every command and the interface use.
   *
   * The lock is held across the whole cycle, and the task is re-read *inside* it, so
   * the planner always sees what is actually on disk right now. That is why a blocked
   * write does not need to retry against a stale copy: by the time it runs, there is no
   * stale copy. A mutation is an intent over current state — "complete this task" means
   * the same thing whatever its tags have become in the meantime.
   */
  updateTask(id: string, plan: (task: Task) => Task, options: LockOptions = {}): Updated<TaskFile> {
    return withLock(
      this.dataDir,
      () => {
        const file = this.load().byId.get(id);
        if (file === undefined) return {kind: 'not-found'} as const;
        try {
          return {kind: 'ok', file: this.apply(file, plan(file.task))} as const;
        } catch (error) {
          return {kind: 'failed', reason: message(error)} as const;
        }
      },
      options,
    );
  }

  updateProject(
    id: string,
    plan: (project: Project) => Project,
    options: LockOptions = {},
  ): Updated<ProjectFile> {
    return withLock(
      this.dataDir,
      () => {
        const file = this.load().projects.find(p => p.project.id === id);
        if (file === undefined) return {kind: 'not-found'} as const;
        try {
          return {kind: 'ok', file: this.applyProject(file, plan(file.project))} as const;
        } catch (error) {
          return {kind: 'failed', reason: message(error)} as const;
        }
      },
      options,
    );
  }

  /** Create a task with the lock held, so its filename cannot collide with a racer. */
  createTask(task: Task, options: LockOptions = {}): Updated<TaskFile> {
    return withLock(
      this.dataDir,
      () => {
        try {
          return {kind: 'ok', file: this.create(task)} as const;
        } catch (error) {
          return {kind: 'failed', reason: message(error)} as const;
        }
      },
      options,
    );
  }

  createProjectSafely(project: Project, options: LockOptions = {}): Updated<ProjectFile> {
    return withLock(
      this.dataDir,
      () => {
        try {
          return {kind: 'ok', file: this.createProject(project)} as const;
        } catch (error) {
          return {kind: 'failed', reason: message(error)} as const;
        }
      },
      options,
    );
  }

  removeTask(id: string, options: LockOptions = {}): Updated<TaskFile> {
    return withLock(
      this.dataDir,
      () => {
        const file = this.load().byId.get(id);
        if (file === undefined) return {kind: 'not-found'} as const;
        try {
          this.remove(file);
          return {kind: 'ok', file} as const;
        } catch (error) {
          return {kind: 'failed', reason: message(error)} as const;
        }
      },
      options,
    );
  }

  /** Run several mutations under one lock, for a command that changes many files. */
  batch<T>(action: () => T, options: LockOptions = {}): T {
    return withLock(this.dataDir, action, options);
  }

  /** Read a document the app owns outright, or undefined if it is not there yet. */
  readDocument(name: string): string | undefined {
    const path = join(this.dataDir, name);
    try {
      return readFileSync(path, 'utf8');
    } catch {
      return undefined;
    }
  }

  /** Write a document the app owns outright, such as AGENTS.md. */
  writeDocument(name: string, content: string): string {
    const path = join(this.dataDir, name);
    mkdirSync(dirname(path), {recursive: true});
    atomicWrite(path, content, {force: true});
    return path;
  }
}
