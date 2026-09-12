/**
 * The single snapshot the interface subscribes to.
 *
 * Every mutation follows one path: a pure planner in `core/` describes the change, the
 * store takes the lock and re-reads the task before applying it, and then the whole
 * world is re-read. Re-reading in full is deliberate. A personal task system holds
 * hundreds of files, so a rescan is cheap, and it removes an entire category of
 * cache-coherence bugs — which matters here more than usual, because agents change
 * these files while the interface is open.
 *
 * Note that mutations take a *planner*, not a finished task. The interface is often
 * looking at a row that is a few hundred milliseconds old; by handing over the intent
 * instead of the result, whatever an agent did in the meantime is preserved.
 */
import {diffSnapshots} from '../core/diff.ts';
import {LockTimeoutError} from '../store/lock.ts';
import type {Change} from '../core/diff.ts';
import type {Snapshot} from '../core/snapshot.ts';
import type {Project, ProjectFile, Task, TaskFile} from '../core/types.ts';
import type {Store} from '../store/store.ts';
import type {Watcher} from '../store/watch.ts';

export type MutationResult<T> = {ok: true; value: T} | {ok: false; message: string};

export interface LiveStoreOptions {
  now: () => string;
  /** Told about paths we wrote, so it does not report our own changes back to us. */
  watcher?: Watcher;
}

export class LiveStore {
  private current: Snapshot;
  private readonly listeners = new Set<() => void>();
  private readonly externalListeners = new Set<(changes: Change[]) => void>();

  constructor(
    private readonly store: Store,
    private readonly options: LiveStoreOptions,
  ) {
    this.current = store.load();
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  /**
   * Must return the same object until something actually changes, or React will
   * re-render forever.
   */
  readonly getSnapshot = (): Snapshot => this.current;

  get dataDir(): string {
    return this.store.dataDir;
  }

  now(): string {
    return this.options.now();
  }

  mintId(): string {
    return this.store.mintId();
  }

  /** Re-read everything and tell React. */
  refresh(): void {
    this.current = this.store.load();
    for (const listener of this.listeners) listener();
  }

  /**
   * Hear about changes someone else made. The interface uses this to say what happened
   * rather than letting a row silently vanish.
   */
  readonly onExternal = (listener: (changes: Change[]) => void): (() => void) => {
    this.externalListeners.add(listener);
    return () => {
      this.externalListeners.delete(listener);
    };
  };

  /** A reload triggered by the watcher rather than by us. */
  refreshFromDisk(): void {
    const before = this.current;
    this.refresh();
    const changes = diffSnapshots(before, this.current);
    if (changes.length === 0) return;
    for (const listener of this.externalListeners) listener(changes);
  }

  /** Throw away the incremental parse cache and reread. Bound to `r`. */
  reload(): void {
    this.store.invalidate();
    this.refresh();
  }

  private settle<T>(run: () => {kind: string; file?: T; reason?: string}): MutationResult<T> {
    try {
      const result = run();
      this.refresh();
      if (result.kind === 'ok' && result.file !== undefined) {
        return {ok: true, value: result.file};
      }
      return {
        ok: false,
        message:
          result.kind === 'not-found'
            ? 'that task is no longer there; something else changed it first'
            : (result.reason ?? 'that did not work'),
      };
    } catch (error) {
      this.refresh();
      if (error instanceof LockTimeoutError) {
        // Keep the interface responsive: report and let the user try again, rather
        // than freezing the render loop behind someone else's write.
        return {ok: false, message: 'someone else is writing; try again in a moment'};
      }
      return {ok: false, message: error instanceof Error ? error.message : String(error)};
    }
  }

  /** Change a task by intent. The planner sees the task as it is on disk right now. */
  update(id: string, plan: (task: Task) => Task): MutationResult<TaskFile> {
    this.suppress(this.current.byId.get(id)?.path);
    const result = this.settle(() => this.store.updateTask(id, plan, {timeoutMs: 1_500}));
    if (result.ok) this.suppress(result.value.path);
    return result;
  }

  create(task: Task): MutationResult<TaskFile> {
    const result = this.settle(() => this.store.createTask(task, {timeoutMs: 1_500}));
    if (result.ok) this.suppress(result.value.path);
    return result;
  }

  remove(id: string): MutationResult<TaskFile> {
    this.suppress(this.current.byId.get(id)?.path);
    return this.settle(() => this.store.removeTask(id, {timeoutMs: 1_500}));
  }

  updateProject(id: string, plan: (project: Project) => Project): MutationResult<ProjectFile> {
    const before = this.current.projects.find(file => file.project.id === id);
    this.suppress(before?.path);
    const result = this.settle(() => this.store.updateProject(id, plan, {timeoutMs: 1_500}));
    if (result.ok) this.suppress(result.value.path);
    return result;
  }

  /** Read a document the app owns, such as the review log. */
  readDocument(name: string): string | undefined {
    return this.store.readDocument(name);
  }

  /** Write a document the app owns. Not a task, so it needs no lock or diffing. */
  writeDocument(name: string, content: string): void {
    this.store.writeDocument(name, content);
  }

  /**
   * Keep the watcher quiet about one file we are writing ourselves.
   *
   * Only the paths actually involved are suppressed. Silencing every file, which is
   * what this used to do, left a window after each of your own edits where an agent's
   * change to some unrelated task went unnoticed. A move touches two paths, so both the
   * old and the new one are suppressed; suppressing the new one after the write still
   * lands ahead of the watcher's debounce, and an extra redraw would be harmless anyway.
   */
  private suppress(path: string | undefined): void {
    if (path !== undefined) this.options.watcher?.suppress(path);
  }
}

