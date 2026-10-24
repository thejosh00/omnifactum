/**
 * R2: what `omni serve` does before it answers anyone — listens on 127.0.0.1 unless
 * told otherwise, refuses a non-loopback bind while any account has no PIN, and keeps
 * the data directory to its owner (0700 directories, 0600 files), tightening whatever
 * an older version left looser.
 */
import {afterEach, expect, test} from 'bun:test';
import {chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {run, isLoopback, type ServeRequest} from '../../src/cli.ts';
import {takeBackup} from '../../src/db/backup.ts';
import {DB_FILE, findAccount, openDatabase, setPin} from '../../src/db/database.ts';

const dirs: string[] = [];
const procs: Array<ReturnType<typeof Bun.spawn>> = [];
afterEach(() => {
  for (const proc of procs.splice(0)) proc.kill();
  for (const dir of dirs.splice(0)) rmSync(dir, {recursive: true, force: true});
});

function freshDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'omni-r2-serve-'));
  dirs.push(dir);
  return dir;
}

const mode = (path: string) => statSync(path).mode & 0o777;

/** Start the real CLI's `serve` and wait for it to say where it listens (or exit). */
async function spawnServe(dir: string, args: string[] = [], env: Record<string, string> = {}) {
  const proc = Bun.spawn(['bun', 'run', 'src/cli.ts', 'serve', '--port', '0', ...args], {
    env: {...process.env, OMNI_DIR: dir, NO_COLOR: '1', ...env},
    stdout: 'pipe',
    stderr: 'pipe',
  });
  procs.push(proc);
  const reader = proc.stdout.getReader();
  const decoder = new TextDecoder();
  let stdout = '';
  const deadline = Date.now() + 15_000;
  while (!/on this machine:\s+http:\/\/localhost:\d+/.test(stdout) && Date.now() < deadline) {
    const chunk = await Promise.race([
      reader.read(),
      proc.exited.then(() => ({done: true, value: undefined})),
    ]);
    if (chunk.done) break;
    stdout += decoder.decode(chunk.value);
  }
  reader.releaseLock();
  const exited = await Promise.race([proc.exited, Bun.sleep(50).then(() => undefined)]);
  const stderr = exited === undefined ? '' : await new Response(proc.stderr).text();
  return {proc, stdout, stderr, exitCode: exited};
}

async function captureServeRequest(env: Record<string, string>, argv: string[] = ['serve']) {
  let seen: ServeRequest | undefined;
  const err: string[] = [];
  const code = await run({argv, out: () => {}, err: line => err.push(line ?? ''), env, serve: async request => ((seen = request), 0)});
  return {code, seen, err: err.join('\n')};
}

test('with no host flag or env, omni serve listens on 127.0.0.1 only', async () => {
  const dir = freshDir();
  const {seen} = await captureServeRequest({OMNI_DIR: dir});
  expect(seen?.hostname).toBe('127.0.0.1');

  const started = await spawnServe(dir);
  expect(started.exitCode).toBeUndefined();
  expect(started.stdout).toMatch(/listening on 127\.0\.0\.1:\d+/);
  expect(started.stdout).not.toContain('on your network');
});

test('--host and OMNI_HOST still choose the bind, and --allowed-hosts / OMNI_ALLOWED_HOSTS reach the server', async () => {
  const dir = freshDir();
  expect((await captureServeRequest({OMNI_DIR: dir, OMNI_HOST: 'localhost'})).seen?.hostname).toBe('localhost');
  const flagged = await captureServeRequest({OMNI_DIR: dir}, ['serve', '--host', '127.0.0.2', '--allowed-hosts', 'Omni.LAN, box:8080']);
  expect(flagged.seen?.hostname).toBe('127.0.0.2');
  expect(flagged.seen?.allowedHosts).toEqual(['omni.lan', 'box:8080']);
  expect((await captureServeRequest({OMNI_DIR: dir, OMNI_ALLOWED_HOSTS: 'a.lan'})).seen?.allowedHosts).toEqual(['a.lan']);
  const bad = await captureServeRequest({OMNI_DIR: dir}, ['serve', '--allowed-hosts', 'evil/x']);
  expect(bad.code).not.toBe(0);
  expect(bad.err).toContain('evil/x');
});

test('isLoopback', () => {
  for (const host of ['127.0.0.1', '127.0.0.2', 'localhost', '::1', '[::1]']) expect(isLoopback(host)).toBe(true);
  for (const host of ['0.0.0.0', '::', '192.168.1.5', 'omni.lan']) expect(isLoopback(host)).toBe(false);
});

test('omni serve --host 0.0.0.0 with a PIN-less account exits non-zero naming that account', async () => {
  const dir = freshDir();
  const db = openDatabase(join(dir, DB_FILE));
  setPin(db, findAccount(db, 'work')!.id, '4821');
  db.close();

  const started = await spawnServe(dir, ['--host', '0.0.0.0']);
  const code = started.exitCode ?? (await started.proc.exited);
  const stderr = started.stderr || (await new Response(started.proc.stderr).text());
  expect(code).not.toBe(0);
  expect(stderr).toContain('home');
  expect(stderr).not.toMatch(/: .*\bwork\b.*$/m);
  expect(stderr).toContain('omni account pin');
  expect(started.stdout).not.toContain('serving');
});

test('omni serve --host 0.0.0.0 with every account PIN\'d starts', async () => {
  const dir = freshDir();
  const db = openDatabase(join(dir, DB_FILE));
  setPin(db, findAccount(db, 'work')!.id, '4821');
  setPin(db, findAccount(db, 'home')!.id, '1234');
  db.close();

  const started = await spawnServe(dir, ['--host', '0.0.0.0']);
  expect(started.exitCode).toBeUndefined();
  expect(started.stdout).toMatch(/listening on 0\.0\.0\.0:\d+/);
  const port = Number(/localhost:(\d+)/.exec(started.stdout)![1]);
  // Over loopback it still answers; under a LAN name it is refused until allowed.
  expect((await fetch(`http://127.0.0.1:${port}/api/accounts`)).status).toBe(200);
  expect((await fetch(`http://127.0.0.1:${port}/api/accounts`, {headers: {host: `omni.lan:${port}`}})).status).toBe(403);
});

test('a new data directory is created 0700 with the db, -wal, -shm, token and backups 0600', async () => {
  const dir = join(freshDir(), 'nested', 'data');
  const db = openDatabase(join(dir, DB_FILE));
  db.exec('CREATE TABLE scratch (x)');
  takeBackup(db, join(dir, 'backups'), 'omni-2026-10-24.db');
  expect(mode(dir)).toBe(0o700);
  for (const file of [DB_FILE, `${DB_FILE}-wal`, `${DB_FILE}-shm`]) expect(mode(join(dir, file))).toBe(0o600);
  expect(mode(join(dir, 'backups'))).toBe(0o700);
  expect(mode(join(dir, 'backups', 'omni-2026-10-24.db'))).toBe(0o600);
  db.close();

  const code = await run({argv: ['account', 'token', 'work', 'you', '--save'], out: () => {}, err: () => {}, env: {OMNI_DIR: dir}});
  expect(code).toBe(0);
  expect(mode(join(dir, 'token'))).toBe(0o600);
});

test('after start on a loose data dir, every private file and directory is tightened', async () => {
  const dir = freshDir();
  const db = openDatabase(join(dir, DB_FILE));
  takeBackup(db, join(dir, 'backups'), 'omni-2026-10-23.db');
  db.close();
  writeFileSync(join(dir, 'token'), 'omni_x\n');
  mkdirSync(join(dir, 'logs'), {recursive: true});
  // What an older version, with a 022 umask, left behind.
  chmodSync(dir, 0o755);
  chmodSync(join(dir, 'backups'), 0o755);
  for (const file of [DB_FILE, 'token', join('backups', 'omni-2026-10-23.db')]) chmodSync(join(dir, file), 0o644);
  for (const file of [`${DB_FILE}-wal`, `${DB_FILE}-shm`]) if (existsSync(join(dir, file))) chmodSync(join(dir, file), 0o644);

  const started = await spawnServe(dir);
  expect(started.exitCode).toBeUndefined();

  expect(mode(dir)).toBe(0o700);
  expect(mode(join(dir, 'backups'))).toBe(0o700);
  for (const file of [DB_FILE, `${DB_FILE}-wal`, `${DB_FILE}-shm`, 'token', join('backups', 'omni-2026-10-23.db')]) {
    expect({file, mode: mode(join(dir, file))}).toEqual({file, mode: 0o600});
  }
  // Today's daily backup, taken on start, is private too.
  const today = join(dir, 'backups');
  for (const name of readdirSync(today)) expect(mode(join(today, name))).toBe(0o600);
});

test('tightening never loosens: a file already stricter than 0600 is left alone', async () => {
  const dir = freshDir();
  openDatabase(join(dir, DB_FILE)).close();
  writeFileSync(join(dir, 'token'), 'omni_x\n');
  chmodSync(join(dir, 'token'), 0o400);
  const started = await spawnServe(dir);
  expect(started.exitCode).toBeUndefined();
  expect(mode(join(dir, 'token'))).toBe(0o400);
});
