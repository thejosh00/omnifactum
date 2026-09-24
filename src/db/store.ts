/**
 * The bridge between pure core values and the database.
 *
 * The store contains no decisions. Core works out what a task should become; this
 * carries the result to a row, inside a transaction, without clobbering anyone.
 *
 * A `Store` is one account seen by one actor. It is cheap to construct, and the server
 * makes one per request, so every write knows whose list it touches and who made it.
 *
 * Mutations take a *planner*, not a finished task, and the planner runs against the row
 * as it stands inside the transaction. A request that was composed against a copy a
 * few seconds old therefore cannot undo what an agent did in the meantime: "complete
 * this task" means the same thing whatever its tags have become since.
 */
import {randomBytes} from 'node:crypto';
import type {Database} from 'bun:sqlite';
import {changeBetween, type Change} from '../core/diff.ts';
import {mintId} from '../core/id.ts';
import {formatLogEntry} from '../core/log.ts';
import {ACTOR_USER} from '../core/mutation.ts';
import {buildSnapshot, type Snapshot} from '../core/snapshot.ts';
import {isAppAuthoredStem, stemFor, uniqueStem} from '../core/slug.ts';
import {nowIso} from '../core/time.ts';
import type {
  LogEntry,
  Project,
  ProjectFile,
  ProjectState,
  Task,
  TaskFile,
  TaskState,
} from '../core/types.ts';
import {isBusy} from './busy.ts';
import type {Account} from './database.ts';
import type {EventEntity, EventHub, StoredEvent} from './events.ts';

/** What a mutation did. */
export type Updated<T> =
  | {kind: 'ok'; file: T}
  | {kind: 'not-found'}
  | {kind: 'failed'; reason: string}
  /** The caller edited a copy that has since changed. `file` is what is there now. */
  | {kind: 'stale'; file: T};

export interface StoreOptions {
  /** Who is making changes through this store, for the event feed. */
  actor?: string;
  /** Told about every committed change, so browsers can be updated live. */
  hub?: EventHub;
  /** Injected so tests are deterministic; both default to the real clock and RNG. */
  now?: () => string;
  mint?: () => string;
}

export interface UpdateOptions {
  /** Refuse the write unless the stored version is still this one. */
  expectVersion?: number;
}

/** Kept per connection, because several stores share one and may nest. */
interface TransactionState {
  depth: number;
  pending: StoredEvent[];
  hub?: EventHub;
}

const transactions = new WeakMap<Database, TransactionState>();

function stateFor(db: Database): TransactionState {
  let state = transactions.get(db);
  if (state === undefined) {
    state = {depth: 0, pending: []};
    transactions.set(db, state);
  }
  return state;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

interface TaskRow {
  id: string;
  stem: string;
  title: string;
  state: string;
  tags: string;
  project: string | null;
  created: string;
  due: string | null;
  defer: string | null;
  waiting_on: string | null;
  asked: string | null;
  done: string | null;
  body: string;
  version: number;
}

interface ProjectRow {
  id: string;
  stem: string;
  title: string;
  outcome: string;
  state: string;
  tags: string;
  created: string;
  due: string | null;
  reviewed: string | null;
  done: string | null;
  aliases: string;
  body: string;
  version: number;
}

interface LogRow {
  owner: string;
  at: string;
  actor: string;
  text: string;
}

function toLogEntry(row: LogRow): LogEntry {
  return {
    at: row.at,
    actor: row.actor,
    text: row.text,
    raw: formatLogEntry(row.at, row.actor, row.text),
    parsed: true,
  };
}

function groupLogs(rows: LogRow[]): Map<string, LogEntry[]> {
  const byOwner = new Map<string, LogEntry[]>();
  for (const row of rows) {
    const list = byOwner.get(row.owner) ?? [];
    list.push(toLogEntry(row));
    byOwner.set(row.owner, list);
  }
  return byOwner;
}

function rowToTask(row: TaskRow, log: LogEntry[]): TaskFile {
  const task: Task = {
    id: row.id,
    title: row.title,
    created: row.created,
    state: row.state as TaskState,
    tags: JSON.parse(row.tags) as string[],
    body: row.body,
    log,
    repairs: [],
  };
  if (row.project !== null) task.project = row.project;
  if (row.due !== null) task.due = row.due;
  if (row.defer !== null) task.defer = row.defer;
  if (row.waiting_on !== null) task.waitingOn = row.waiting_on;
  if (row.asked !== null) task.asked = row.asked;
  if (row.done !== null) task.done = row.done;
  return {task, stem: row.stem, version: row.version};
}

function rowToProject(row: ProjectRow, log: LogEntry[]): ProjectFile {
  const project: Project = {
    id: row.id,
    title: row.title,
    outcome: row.outcome,
    created: row.created,
    state: row.state as ProjectState,
    tags: JSON.parse(row.tags) as string[],
    aliases: JSON.parse(row.aliases) as string[],
    body: row.body,
    log,
    repairs: [],
  };
  if (row.due !== null) project.due = row.due;
  if (row.reviewed !== null) project.reviewed = row.reviewed;
  if (row.done !== null) project.done = row.done;
  return {project, stem: row.stem, version: row.version};
}

export class Store {
  constructor(
    private readonly db: Database,
    readonly account: Account,
    private readonly options: StoreOptions = {},
  ) {}

  get actor(): string {
    return this.options.actor ?? ACTOR_USER;
  }

  private now(): string {
    return this.options.now?.() ?? nowIso();
  }

  private mint(): string {
    return this.options.mint?.() ?? mintId(Date.now(), randomBytes(4));
  }

  /** A fresh id, for a new task or project. */
  mintId(): string {
    return this.mint();
  }

  /** The same store acting for someone else, such as the tickler acting as `omni`. */
  as(actor: string): Store {
    return new Store(this.db, this.account, {...this.options, actor});
  }

  // --- reading -------------------------------------------------------------------

  /** Read the whole account. Cheap enough to do on every request. */
  load(): Snapshot {
    const accountId = this.account.id;
    const taskLogs = groupLogs(
      this.db
        .query(
          `SELECT task_id AS owner, at, actor, text FROM task_log
           WHERE account_id = ? ORDER BY task_id, seq`,
        )
        .all(accountId) as LogRow[],
    );
    const tasks = (
      this.db.query('SELECT * FROM tasks WHERE account_id = ? ORDER BY id').all(accountId) as TaskRow[]
    ).map(row => rowToTask(row, taskLogs.get(row.id) ?? []));

    const projectLogs = groupLogs(
      this.db
        .query(
          `SELECT project_id AS owner, at, actor, text FROM project_log
           WHERE account_id = ? ORDER BY project_id, seq`,
        )
        .all(accountId) as LogRow[],
    );
    const projects = (
      this.db
        .query('SELECT * FROM projects WHERE account_id = ? ORDER BY id')
        .all(accountId) as ProjectRow[]
    ).map(row => rowToProject(row, projectLogs.get(row.id) ?? []));

    return buildSnapshot(tasks, projects);
  }

  getTask(id: string): TaskFile | undefined {
    const row = this.db
      .query('SELECT * FROM tasks WHERE account_id = ? AND id = ?')
      .get(this.account.id, id) as TaskRow | null;
    if (row === null) return undefined;
    const logs = this.db
      .query(
        `SELECT task_id AS owner, at, actor, text FROM task_log
         WHERE account_id = ? AND task_id = ? ORDER BY seq`,
      )
      .all(this.account.id, id) as LogRow[];
    return rowToTask(row, logs.map(toLogEntry));
  }

  getProject(id: string): ProjectFile | undefined {
    const row = this.db
      .query('SELECT * FROM projects WHERE account_id = ? AND id = ?')
      .get(this.account.id, id) as ProjectRow | null;
    if (row === null) return undefined;
    const logs = this.db
      .query(
        `SELECT project_id AS owner, at, actor, text FROM project_log
         WHERE account_id = ? AND project_id = ? ORDER BY seq`,
      )
      .all(this.account.id, id) as LogRow[];
    return rowToProject(row, logs.map(toLogEntry));
  }

  // --- transactions --------------------------------------------------------------

  /**
   * Run several reads and writes as one unit. Nothing another writer does can land in
   * the middle, and nothing is announced until the whole thing has committed.
   *
   * Nesting is allowed and joins the outer transaction.
   */
  batch<T>(action: () => T): T {
    const state = stateFor(this.db);
    if (state.depth > 0) {
      state.depth += 1;
      try {
        return action();
      } finally {
        state.depth -= 1;
      }
    }

    // IMMEDIATE takes the write lock up front, so a read-then-write inside the batch
    // can never be overtaken by another writer between the two.
    this.db.exec('BEGIN IMMEDIATE');
    state.depth = 1;
    state.hub = this.options.hub;
    let result: T;
    try {
      result = action();
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      state.pending = [];
      throw error;
    } finally {
      state.depth = 0;
    }

    const events = state.pending;
    const hub = state.hub;
    state.pending = [];
    state.hub = undefined;
    for (const event of events) hub?.publish(event);
    return result;
  }

  private record(before: Task | undefined, after: Task | undefined, edited: boolean): void {
    const change = changeBetween(before, after, edited);
    if (change === undefined) return;

    // The note is only this write's note: an old one belongs to an older change.
    const grew = (after?.log.length ?? 0) > (before?.log.length ?? 0);
    const event: Change = {...change, actor: this.actor};
    if (grew && change.note !== undefined) event.note = change.note;
    else delete event.note;
    this.announce(event, 'task');
  }

  /** The project twin of `record`: added, completed, moved, or otherwise edited. */
  private recordProject(before: Project | undefined, after: Project): void {
    const event: Change = {kind: 'edited', id: after.id, title: after.title, to: after.state, actor: this.actor};
    if (before === undefined) event.kind = 'added';
    else if (before.state !== after.state) {
      event.kind = after.state === 'done' ? 'completed' : 'moved';
      event.from = before.state;
    }
    if (after.log.length > (before?.log.length ?? 0)) {
      const latest = after.log.at(-1);
      if (latest !== undefined && latest.text.length > 0) event.note = latest.text;
    }
    this.announce(event, 'project');
  }

  /** Write an event, to be published once the surrounding transaction commits. */
  private announce(event: Change, entity: EventEntity): void {
    const at = this.now();
    const inserted = this.db
      .query(
        `INSERT INTO events (account_id, at, kind, task_id, title, from_state, to_state, actor, note, entity)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING seq`,
      )
      .get(
        this.account.id,
        at,
        event.kind,
        event.id,
        event.title,
        event.from ?? null,
        event.to ?? null,
        event.actor ?? null,
        event.note ?? null,
        entity,
      ) as {seq: number};

    stateFor(this.db).pending.push({seq: inserted.seq, accountId: this.account.id, at, entity, change: event});
  }

  // --- tasks ---------------------------------------------------------------------

  private takenStems(table: 'tasks' | 'projects', excludeId?: string): string[] {
    const rows = this.db
      .query(`SELECT stem FROM ${table} WHERE account_id = ? AND id != ?`)
      .all(this.account.id, excludeId ?? '') as Array<{stem: string}>;
    return rows.map(row => row.stem);
  }

  private writeTaskLog(task: Task): void {
    this.db
      .query('DELETE FROM task_log WHERE account_id = ? AND task_id = ?')
      .run(this.account.id, task.id);
    const insert = this.db.query(
      'INSERT INTO task_log (account_id, task_id, seq, at, actor, text) VALUES (?, ?, ?, ?, ?, ?)',
    );
    task.log.forEach((entry, seq) => {
      insert.run(this.account.id, task.id, seq, entry.at, entry.actor, entry.parsed ? entry.text : entry.raw.trim());
    });
  }

  private taskValues(task: Task) {
    return [
      task.title,
      task.state,
      JSON.stringify(task.tags),
      task.project ?? null,
      task.created,
      task.due ?? null,
      task.defer ?? null,
      task.waitingOn ?? null,
      task.asked ?? null,
      task.done ?? null,
      task.body,
    ] as const;
  }

  /** Insert a brand-new task. Fails if the id is already taken in this account. */
  private insertTask(task: Task, stem?: string): TaskFile {
    const chosen = uniqueStem(stem ?? stemFor(task.title, task.id), this.takenStems('tasks'));
    this.db
      .query(
        `INSERT INTO tasks (account_id, id, stem, title, state, tags, project, created, due,
                            defer, waiting_on, asked, done, body, version)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
      )
      .run(this.account.id, task.id, chosen, ...this.taskValues(task));
    this.writeTaskLog(task);
    this.record(undefined, task, true);
    return {task, stem: chosen, version: 1};
  }

  /** Create a task. */
  createTask(task: Task): Updated<TaskFile> {
    try {
      return this.batch(() => ({kind: 'ok', file: this.insertTask(task)}) as const);
    } catch (error) {
      // Busy is not this task's fault; let it reach the caller as busy, so it can retry.
      if (isBusy(error)) throw error;
      return {kind: 'failed', reason: message(error)};
    }
  }

  /** Bring a task in from elsewhere, keeping its stem where it can. Used by import. */
  importTask(task: Task, stem: string): Updated<TaskFile> {
    return this.batch(() => {
      if (this.getTask(task.id) !== undefined) {
        return {kind: 'failed', reason: `a task with id ${task.id} is already here`} as const;
      }
      return {kind: 'ok', file: this.insertTask(task, stem)} as const;
    });
  }

  /**
   * The safe way to change a task, and the one every command and the web app use.
   *
   * The planner runs against the row as it is inside the transaction, never against a
   * copy the caller is holding. With `expectVersion`, the write is refused if the task
   * has changed since the caller read it — for edits that replace a field outright,
   * where re-planning cannot tell what the person meant.
   */
  updateTask(id: string, plan: (task: Task) => Task, options: UpdateOptions = {}): Updated<TaskFile> {
    return this.batch(() => {
      const current = this.getTask(id);
      if (current === undefined) return {kind: 'not-found'} as const;
      if (options.expectVersion !== undefined && options.expectVersion !== current.version) {
        return {kind: 'stale', file: current} as const;
      }

      let next: Task;
      try {
        next = plan(current.task);
      } catch (error) {
        return {kind: 'failed', reason: message(error)} as const;
      }
      return {kind: 'ok', file: this.applyTask(current, next)} as const;
    });
  }

  /** Write a planned task over the current row. Must run inside a batch. */
  private applyTask(current: TaskFile, next: Task): TaskFile {
    // A stem the app chose follows the title; one someone chose on purpose stays put.
    const titleChanged = next.title !== current.task.title;
    const appNamedIt = isAppAuthoredStem(current.stem, current.task.title, current.task.id);
    const stem =
      titleChanged && appNamedIt
        ? uniqueStem(stemFor(next.title, next.id), this.takenStems('tasks', current.task.id))
        : current.stem;

    this.db
      .query(
        `UPDATE tasks SET stem = ?, title = ?, state = ?, tags = ?, project = ?, created = ?,
                          due = ?, defer = ?, waiting_on = ?, asked = ?, done = ?, body = ?,
                          version = version + 1
         WHERE account_id = ? AND id = ?`,
      )
      .run(stem, ...this.taskValues(next), this.account.id, current.task.id);
    this.writeTaskLog(next);
    this.record(current.task, next, true);
    return {task: next, stem, version: current.version + 1};
  }

  /**
   * Delete a task. There is no trash, by decision, so this is real. Callers confirm
   * first; the store does as it is told.
   */
  removeTask(id: string): Updated<TaskFile> {
    return this.batch(() => {
      const current = this.getTask(id);
      if (current === undefined) return {kind: 'not-found'} as const;
      this.db.query('DELETE FROM tasks WHERE account_id = ? AND id = ?').run(this.account.id, id);
      this.record(current.task, undefined, true);
      return {kind: 'ok', file: current} as const;
    });
  }

  // --- projects ------------------------------------------------------------------

  private writeProjectLog(project: Project): void {
    this.db
      .query('DELETE FROM project_log WHERE account_id = ? AND project_id = ?')
      .run(this.account.id, project.id);
    const insert = this.db.query(
      'INSERT INTO project_log (account_id, project_id, seq, at, actor, text) VALUES (?, ?, ?, ?, ?, ?)',
    );
    project.log.forEach((entry, seq) => {
      insert.run(this.account.id, project.id, seq, entry.at, entry.actor, entry.parsed ? entry.text : entry.raw.trim());
    });
  }

  private projectValues(project: Project) {
    return [
      project.title,
      project.outcome,
      project.state,
      JSON.stringify(project.tags),
      project.created,
      project.due ?? null,
      project.reviewed ?? null,
      project.done ?? null,
      JSON.stringify(project.aliases),
      project.body,
    ] as const;
  }

  private insertProject(project: Project, stem?: string): ProjectFile {
    const chosen = uniqueStem(stem ?? stemFor(project.title, project.id), this.takenStems('projects'));
    this.db
      .query(
        `INSERT INTO projects (account_id, id, stem, title, outcome, state, tags, created, due,
                               reviewed, done, aliases, body, version)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
      )
      .run(this.account.id, project.id, chosen, ...this.projectValues(project));
    this.writeProjectLog(project);
    this.recordProject(undefined, project);
    return {project, stem: chosen, version: 1};
  }

  createProjectSafely(project: Project): Updated<ProjectFile> {
    try {
      return this.batch(() => ({kind: 'ok', file: this.insertProject(project)}) as const);
    } catch (error) {
      if (isBusy(error)) throw error;
      return {kind: 'failed', reason: message(error)};
    }
  }

  importProject(project: Project, stem: string): Updated<ProjectFile> {
    return this.batch(() => {
      if (this.getProject(project.id) !== undefined) {
        return {kind: 'failed', reason: `a project with id ${project.id} is already here`} as const;
      }
      return {kind: 'ok', file: this.insertProject(project, stem)} as const;
    });
  }

  updateProject(
    id: string,
    plan: (project: Project) => Project,
    options: UpdateOptions = {},
  ): Updated<ProjectFile> {
    return this.batch(() => {
      const current = this.getProject(id);
      if (current === undefined) return {kind: 'not-found'} as const;
      if (options.expectVersion !== undefined && options.expectVersion !== current.version) {
        return {kind: 'stale', file: current} as const;
      }

      let next: Project;
      try {
        next = plan(current.project);
      } catch (error) {
        return {kind: 'failed', reason: message(error)} as const;
      }

      const titleChanged = next.title !== current.project.title;
      const appNamedIt = isAppAuthoredStem(current.stem, current.project.title, current.project.id);
      const stem =
        titleChanged && appNamedIt
          ? uniqueStem(stemFor(next.title, next.id), this.takenStems('projects', id))
          : current.stem;

      this.db
        .query(
          `UPDATE projects SET stem = ?, title = ?, outcome = ?, state = ?, tags = ?, created = ?,
                               due = ?, reviewed = ?, done = ?, aliases = ?, body = ?,
                               version = version + 1
           WHERE account_id = ? AND id = ?`,
        )
        .run(stem, ...this.projectValues(next), this.account.id, id);
      this.writeProjectLog(next);
      this.recordProject(current.project, next);
      return {kind: 'ok', file: {project: next, stem, version: current.version + 1}} as const;
    });
  }

  // --- documents -----------------------------------------------------------------

  /** Read a document the app owns outright, or undefined if it is not there yet. */
  readDocument(name: string): string | undefined {
    const row = this.db
      .query('SELECT content FROM documents WHERE account_id = ? AND name = ?')
      .get(this.account.id, name) as {content: string} | null;
    return row?.content;
  }

  /** Write a document the app owns outright, such as the weekly review log. */
  writeDocument(name: string, content: string): void {
    this.db
      .query(
        `INSERT INTO documents (account_id, name, content) VALUES (?, ?, ?)
         ON CONFLICT (account_id, name) DO UPDATE SET content = excluded.content`,
      )
      .run(this.account.id, name, content);
  }
}
