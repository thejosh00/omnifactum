/**
 * R16: migrations only go forward and run on the user's real data when the server
 * restarts, so an existing database is backed up, at its old version, before the first
 * pending migration, under a name the daily prune never touches.
 */
import {Database} from 'bun:sqlite';
import {afterEach, beforeEach, expect, test} from 'bun:test';
import {existsSync, mkdtempSync, readdirSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {BACKUP_DIR, dailyBackup, listBackups} from '../../src/db/backup.ts';
import {DB_FILE, MIGRATIONS, openDatabase} from '../../src/db/database.ts';

const SCHEMA_VERSION = MIGRATIONS.length;
/** The version an older build left behind: every shipped migration but the last. */
const OLDER = SCHEMA_VERSION - 1;

let dir: string;
let path: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'omni-r16-'));
  path = join(dir, DB_FILE);
});
afterEach(() => rmSync(dir, {recursive: true, force: true}));

/** A database file as the previous build left it: the real migrations, all but the last. */
function olderDatabase(): void {
  const db = new Database(path, {create: true});
  for (const migration of MIGRATIONS.slice(0, OLDER)) db.exec(migration);
  db.exec(`PRAGMA user_version = ${OLDER}`);
  db.close();
}

const versionOf = (file: string) => {
  const db = new Database(file, {readonly: true});
  try {
    return (db.query('PRAGMA user_version').get() as {user_version: number}).user_version;
  } finally {
    db.close();
  }
};

test('an older file-backed database is backed up once, at its old version, before it is migrated', () => {
  olderDatabase();
  expect(existsSync(join(dir, BACKUP_DIR))).toBe(false);

  openDatabase(path).close();

  const names = readdirSync(join(dir, BACKUP_DIR));
  expect(names).toHaveLength(1);
  expect(names[0]).toMatch(new RegExp(`^omni-label-pre-migration-v${OLDER}-\\d{8}T\\d{6}\\.db$`));
  expect(versionOf(join(dir, BACKUP_DIR, names[0]!))).toBe(OLDER);
  expect(versionOf(path)).toBe(SCHEMA_VERSION);
  // `omni backup list` shows it, and not as a daily one.
  expect(listBackups(dir).map(b => ({name: b.name, daily: b.daily}))).toEqual([{name: names[0]!, daily: false}]);
  // Already current: opening again takes no second backup.
  openDatabase(path).close();
  expect(readdirSync(join(dir, BACKUP_DIR))).toHaveLength(1);
});

test('a brand-new database and :memory: are not backed up', () => {
  openDatabase(path).close();
  expect(versionOf(path)).toBe(SCHEMA_VERSION);
  expect(existsSync(join(dir, BACKUP_DIR))).toBe(false);

  const before = readdirSync(process.cwd()).sort();
  openDatabase(':memory:').close();
  expect(readdirSync(process.cwd()).sort()).toEqual(before);
  expect(existsSync(join(dir, BACKUP_DIR))).toBe(false);
});

test('a daily prune past the keep count leaves the pre-migration backup in place', () => {
  olderDatabase();
  const db = openDatabase(path);
  const [label] = readdirSync(join(dir, BACKUP_DIR));
  expect(label).toStartWith('omni-label-pre-migration-v');

  for (const day of ['2026-09-10', '2026-09-11', '2026-09-12', '2026-09-13']) dailyBackup(db, dir, new Date(`${day}T18:00:00Z`), 2);
  db.close();

  expect(readdirSync(join(dir, BACKUP_DIR)).sort()).toEqual(['omni-2026-09-12.db', 'omni-2026-09-13.db', label!]);
});
