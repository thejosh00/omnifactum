/**
 * Opening the database, and the schema it holds.
 *
 * One SQLite file holds every account. The server is the only long-lived writer, but
 * `omni import` and `omni account` open the same file from another process while it
 * runs, so the file is in WAL mode with a busy timeout: readers never block, and a
 * second writer waits its turn instead of failing.
 *
 * Migrations are a numbered list applied in order and recorded in `user_version`.
 * Append to the list; never edit an entry that has shipped.
 */
import {Database} from 'bun:sqlite';
import {mkdirSync} from 'node:fs';
import {dirname} from 'node:path';

export const DB_FILE = 'omni.db';

/** The accounts every new database starts with. Each is a separate set of lists. */
export const DEFAULT_ACCOUNTS = ['work', 'home'] as const;

const MIGRATIONS: string[] = [
  `
  CREATE TABLE accounts (
    id    INTEGER PRIMARY KEY,
    name  TEXT NOT NULL UNIQUE,
    pin   TEXT
  );

  CREATE TABLE tokens (
    token       TEXT PRIMARY KEY,
    account_id  INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    actor       TEXT NOT NULL,
    created     TEXT NOT NULL
  );

  CREATE TABLE sessions (
    id          TEXT PRIMARY KEY,
    account_id  INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    created     TEXT NOT NULL
  );

  CREATE TABLE tasks (
    account_id  INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    id          TEXT NOT NULL,
    stem        TEXT NOT NULL,
    title       TEXT NOT NULL,
    state       TEXT NOT NULL,
    tags        TEXT NOT NULL DEFAULT '[]',
    project     TEXT,
    created     TEXT NOT NULL,
    due         TEXT,
    defer       TEXT,
    waiting_on  TEXT,
    asked       TEXT,
    done        TEXT,
    body        TEXT NOT NULL DEFAULT '',
    version     INTEGER NOT NULL DEFAULT 1,
    PRIMARY KEY (account_id, id),
    UNIQUE (account_id, stem)
  );

  CREATE TABLE task_log (
    account_id  INTEGER NOT NULL,
    task_id     TEXT NOT NULL,
    seq         INTEGER NOT NULL,
    at          TEXT NOT NULL,
    actor       TEXT NOT NULL,
    text        TEXT NOT NULL,
    PRIMARY KEY (account_id, task_id, seq),
    FOREIGN KEY (account_id, task_id) REFERENCES tasks(account_id, id) ON DELETE CASCADE
  );

  CREATE TABLE projects (
    account_id  INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    id          TEXT NOT NULL,
    stem        TEXT NOT NULL,
    title       TEXT NOT NULL,
    outcome     TEXT NOT NULL DEFAULT '',
    state       TEXT NOT NULL,
    tags        TEXT NOT NULL DEFAULT '[]',
    created     TEXT NOT NULL,
    due         TEXT,
    reviewed    TEXT,
    done        TEXT,
    aliases     TEXT NOT NULL DEFAULT '[]',
    body        TEXT NOT NULL DEFAULT '',
    version     INTEGER NOT NULL DEFAULT 1,
    PRIMARY KEY (account_id, id),
    UNIQUE (account_id, stem)
  );

  CREATE TABLE project_log (
    account_id  INTEGER NOT NULL,
    project_id  TEXT NOT NULL,
    seq         INTEGER NOT NULL,
    at          TEXT NOT NULL,
    actor       TEXT NOT NULL,
    text        TEXT NOT NULL,
    PRIMARY KEY (account_id, project_id, seq),
    FOREIGN KEY (account_id, project_id) REFERENCES projects(account_id, id) ON DELETE CASCADE
  );

  -- Documents the app owns outright, such as the weekly review log.
  CREATE TABLE documents (
    account_id  INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    name        TEXT NOT NULL,
    content     TEXT NOT NULL,
    PRIMARY KEY (account_id, name)
  );

  -- What changed, and who changed it. Feeds live updates in the browser.
  CREATE TABLE events (
    seq         INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id  INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    at          TEXT NOT NULL,
    kind        TEXT NOT NULL,
    task_id     TEXT NOT NULL,
    title       TEXT NOT NULL,
    from_state  TEXT,
    to_state    TEXT,
    actor       TEXT,
    note        TEXT
  );
  CREATE INDEX events_by_account ON events(account_id, seq);
  `,
  // Projects are announced too, so a project an agent creates appears in open browsers.
  `
  ALTER TABLE events ADD COLUMN entity TEXT NOT NULL DEFAULT 'task';
  `,
];

export interface OpenOptions {
  /** How long a writer waits for another to finish before reporting busy. */
  busyTimeoutMs?: number;
}

/** Open (creating if need be) and bring the schema up to date. `:memory:` works for tests. */
export function openDatabase(path: string, options: OpenOptions = {}): Database {
  if (path !== ':memory:') mkdirSync(dirname(path), {recursive: true});
  const db = new Database(path, {create: true, strict: true});
  db.exec('PRAGMA journal_mode = WAL');
  db.exec(`PRAGMA busy_timeout = ${Math.max(0, Math.floor(options.busyTimeoutMs ?? 5000))}`);
  db.exec('PRAGMA foreign_keys = ON');
  migrate(db);
  return db;
}

function migrate(db: Database): void {
  const current = (db.query('PRAGMA user_version').get() as {user_version: number}).user_version;
  for (let version = current; version < MIGRATIONS.length; version++) {
    db.transaction(() => {
      db.exec(MIGRATIONS[version]!);
      db.exec(`PRAGMA user_version = ${version + 1}`);
    }).immediate();
  }
  const seed = db.query('INSERT OR IGNORE INTO accounts (name) VALUES (?)');
  for (const name of DEFAULT_ACCOUNTS) seed.run(name);
}

export interface Account {
  id: number;
  name: string;
  /** Whether logging in from a browser asks for a PIN. */
  hasPin: boolean;
}

export function listAccounts(db: Database): Account[] {
  const rows = db.query('SELECT id, name, pin FROM accounts ORDER BY id').all() as Array<{
    id: number;
    name: string;
    pin: string | null;
  }>;
  return rows.map(row => ({id: row.id, name: row.name, hasPin: row.pin !== null}));
}

export function findAccount(db: Database, name: string): Account | undefined {
  return listAccounts(db).find(account => account.name === name.trim().toLowerCase());
}

export function createAccount(db: Database, name: string): Account {
  const clean = name.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]*$/.test(clean)) {
    throw new Error('an account name is lowercase letters, digits and dashes');
  }
  db.query('INSERT OR IGNORE INTO accounts (name) VALUES (?)').run(clean);
  return findAccount(db, clean)!;
}

/** Set or clear the PIN a browser must give to open an account. */
export function setPin(db: Database, accountId: number, pin: string | undefined): void {
  const hashed = pin === undefined || pin.length === 0 ? null : Bun.password.hashSync(pin);
  db.query('UPDATE accounts SET pin = ? WHERE id = ?').run(hashed, accountId);
}

export function checkPin(db: Database, accountId: number, pin: string | undefined): boolean {
  const row = db.query('SELECT pin FROM accounts WHERE id = ?').get(accountId) as
    | {pin: string | null}
    | null;
  if (row === null) return false;
  if (row.pin === null) return true;
  return pin !== undefined && Bun.password.verifySync(pin, row.pin);
}
