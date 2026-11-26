/** R30: a daily backup that has stopped is said by the signed-in session reply (I26). */
import {afterEach, beforeEach, expect, test} from 'bun:test';
import {mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {Database} from 'bun:sqlite';
import {createToken} from '../../src/db/auth.ts';
import * as backups from '../../src/db/backup.ts';
import {DB_FILE, findAccount, openDatabase} from '../../src/db/database.ts';
import {startServer, type RunningServer} from '../../src/server/server.ts';

const HOUR = 3_600_000;
const T0 = '2026-09-12T15:00:00.000Z';
let dir: string;
let db: Database;
let running: RunningServer;
let token: string;
const clock = {now: T0};

beforeEach(() => {
  clock.now = T0;
  dir = mkdtempSync(join(tmpdir(), 'omni-r30-'));
  db = openDatabase(join(dir, DB_FILE));
  // The data folder is named but no backup job runs, so nothing takes a fresh backup under the test.
  running = startServer({db, port: 0, hostname: '127.0.0.1', tickler: false, now: () => clock.now, dataDir: dir});
  token = createToken(db, findAccount(db, 'work')!.id, 'you', T0);
});
afterEach(async () => {
  await running.stop();
  db.close();
  rmSync(dir, {recursive: true, force: true});
});

/** A file in backups/, written `hours` before the clock. */
function backupFile(name: string, hours: number): string {
  const folder = join(dir, 'backups');
  mkdirSync(folder, {recursive: true});
  const written = new Date(Date.parse(clock.now) - hours * HOUR);
  writeFileSync(join(folder, name), '');
  utimesSync(join(folder, name), written, written);
  return written.toISOString();
}

const session = async (bearer = token) => (await fetch(`${running.url}/api/session`, {headers: {authorization: `Bearer ${bearer}`}})).json() as Promise<any>;

test('the one constant is 36 hours', () => {
  expect(backups.BACKUP_STALE_MS).toBe(36 * HOUR);
});

test('the session reply says the daily backup is stale past 36 hours, with its time, and not at 35', async () => {
  const written = backupFile('omni-2026-09-10.db', 37);
  expect((await session()).backup).toEqual({last: written, stale: true});
  const fresher = backupFile('omni-2026-09-10.db', 35);
  expect((await session()).backup).toEqual({last: fresher, stale: false});
  // An agent's token is told too; a signed-out request is told nothing.
  const agent = createToken(db, findAccount(db, 'work')!.id, 'agent:claude', T0);
  expect((await session(agent)).backup).toEqual({last: fresher, stale: false});
  const stranger = await fetch(`${running.url}/api/session`);
  expect(stranger.status).toBe(401);
  expect('backup' in ((await stranger.json()) as object)).toBe(false);
});

test('a fresh on-demand, pre-migration or labelled backup beside an old daily one is still stale', async () => {
  const written = backupFile('omni-2026-09-10.db', 40);
  backupFile('omni-2026-09-12T1400.db', 1);
  backupFile(backups.labelledName('pre-migration-v3', T0), 1);
  backupFile(backups.labelledName('before-cleanup', T0), 1);
  expect(backups.listBackups(dir).filter(backup => !backup.daily).length).toBe(3);
  expect((await session()).backup).toEqual({last: written, stale: true});
});

test('with no daily backup at all, stale only once the server has been up that long', async () => {
  backupFile('omni-2026-09-12T1400.db', 1);
  expect((await session()).backup).toEqual({last: null, stale: false});
  clock.now = new Date(Date.parse(T0) + 35 * HOUR).toISOString();
  expect((await session()).backup).toEqual({last: null, stale: false});
  clock.now = new Date(Date.parse(T0) + 37 * HOUR).toISOString();
  expect((await session()).backup).toEqual({last: null, stale: true});
});

test('backupStatus is exact at the edge: 36 hours is not stale, a second more is', () => {
  const written = Date.parse(backupFile('omni-2026-09-10.db', 0));
  const since = new Date(written);
  expect(backups.backupStatus(dir, new Date(written + backups.BACKUP_STALE_MS), since).stale).toBe(false);
  expect(backups.backupStatus(dir, new Date(written + backups.BACKUP_STALE_MS + 1000), since).stale).toBe(true);
});

test('a server with no data folder says nothing about backups', async () => {
  const memory = openDatabase(':memory:');
  const server = startServer({db: memory, port: 0, hostname: '127.0.0.1', tickler: false, now: () => T0});
  const bearer = createToken(memory, findAccount(memory, 'work')!.id, 'you', T0);
  const reply = (await (await fetch(`${server.url}/api/session`, {headers: {authorization: `Bearer ${bearer}`}})).json()) as any;
  expect(reply.ok).toBe(true);
  expect('backup' in reply).toBe(false);
  await server.stop();
  memory.close();
});
