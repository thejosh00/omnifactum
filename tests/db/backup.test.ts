import {afterEach, describe, expect, test} from 'bun:test';
import {existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {
  backupDir,
  dailyBackup,
  dailyName,
  listBackups,
  manualName,
  takeBackup,
  toPrune,
} from '../../src/db/backup.ts';
import {DB_FILE, findAccount, openDatabase} from '../../src/db/database.ts';
import {Store} from '../../src/db/store.ts';
import {planNewTask} from '../../src/core/mutation.ts';
import {startServer} from '../../src/server/server.ts';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, {recursive: true, force: true});
});

function vault() {
  const dir = mkdtempSync(join(tmpdir(), 'omni-backup-'));
  dirs.push(dir);
  const db = openDatabase(join(dir, DB_FILE));
  const store = new Store(db, findAccount(db, 'home')!);
  const add = (title: string) =>
    store.createTask(planNewTask({id: store.mintId(), title, state: 'next', nowIso: '2026-09-23T10:00:00Z'}));
  return {dir, db, add};
}

describe('naming and pruning', () => {
  test('a daily backup is named for the local date, an on-demand one to the minute', () => {
    const at = new Date(2026, 8, 3, 7, 5);
    expect(dailyName(at)).toBe('omni-2026-09-03.db');
    expect(manualName(at)).toBe('omni-2026-09-03T0705.db');
  });

  test('pruning drops the oldest daily backups and never touches on-demand ones', () => {
    const names = [
      'omni-2026-09-01.db',
      'omni-2026-09-02T1200.db',
      'omni-2026-09-03.db',
      'omni-2026-09-04.db',
      'notes.txt',
    ];
    expect(toPrune(names, 2)).toEqual(['omni-2026-09-01.db']);
    expect(toPrune(names, 10)).toEqual([]);
  });
});

describe('taking a backup', () => {
  test('the copy is a working database holding every task', () => {
    const {dir, db, add} = vault();
    add('Fix the fence');
    add('Call the vet');

    const path = takeBackup(db, backupDir(dir), 'omni-2026-09-23.db');
    const copy = openDatabase(path);
    const titles = (copy.query('SELECT title FROM tasks ORDER BY title').all() as Array<{title: string}>).map(r => r.title);
    copy.close();
    expect(titles).toEqual(['Call the vet', 'Fix the fence']);
  });

  test('a failed backup leaves nothing that looks like one', () => {
    const {dir, db} = vault();
    const target = backupDir(dir);
    mkdirSync(target, {recursive: true});
    // A directory where the file should go makes the final rename fail.
    mkdirSync(join(target, 'omni-2026-09-23.db', 'blocker'), {recursive: true});

    expect(() => takeBackup(db, target, 'omni-2026-09-23.db')).toThrow();
    expect(readdirSync(target).filter(name => name.includes('partial'))).toEqual([]);
  });
});

describe('the daily backup', () => {
  test('happens once a day, however often the server checks', () => {
    const {dir, db, add} = vault();
    add('Something');
    const morning = new Date(2026, 8, 23, 8, 0);
    const evening = new Date(2026, 8, 23, 22, 0);

    expect(dailyBackup(db, dir, morning)).toBeDefined();
    expect(dailyBackup(db, dir, evening)).toBeUndefined();
    expect(dailyBackup(db, dir, new Date(2026, 8, 24, 9, 0))).toBeDefined();
    expect(listBackups(dir).map(b => b.name).sort()).toEqual(['omni-2026-09-23.db', 'omni-2026-09-24.db']);
  });

  test('keeps only the most recent fortnight, plus any taken on demand', () => {
    const {dir, db} = vault();
    const target = backupDir(dir);
    mkdirSync(target, {recursive: true});
    writeFileSync(join(target, 'omni-2026-08-01T0900.db'), '');
    for (let day = 1; day <= 20; day++) {
      dailyBackup(db, dir, new Date(2026, 8, day, 9, 0), 14);
    }

    const names = listBackups(dir).map(b => b.name).sort();
    expect(names.filter(name => !name.includes('T'))).toHaveLength(14);
    expect(names[0]).toBe('omni-2026-08-01T0900.db');
    expect(existsSync(join(target, 'omni-2026-09-06.db'))).toBe(false);
    expect(existsSync(join(target, 'omni-2026-09-07.db'))).toBe(true);
  });

  test('the server takes one as soon as it starts', async () => {
    const {dir, db} = vault();
    const lines: string[] = [];
    const running = startServer({db, port: 0, hostname: '127.0.0.1', tickler: false, backups: {dataDir: dir, log: line => lines.push(line)}});
    try {
      expect(listBackups(dir)).toHaveLength(1);
      expect(lines.join('\n')).toContain('backed up to');
    } finally {
      await running.stop();
    }
  });
});
