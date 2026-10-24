/**
 * R2: the server answers only to this machine's loopback names and the names given with
 * --allowed-hosts / OMNI_ALLOWED_HOSTS, refuses writes from a foreign Origin, and limits
 * PIN guessing — so a web page using DNS rebinding, or a stranger on the network, gets a
 * 403 that says how to allow a name, and a PIN guesser gets a 429.
 */
import {afterEach, expect, test} from 'bun:test';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {Database} from 'bun:sqlite';
import {createToken} from '../../src/db/auth.ts';
import {DB_FILE, findAccount, openDatabase, setPin} from '../../src/db/database.ts';
import {startServer, type RunningServer} from '../../src/server/server.ts';
import {acceptedHosts, checkRequest} from '../../src/server/hostCheck.ts';
import {PinLimiter} from '../../src/server/pinLimit.ts';

let dir: string;
let db: Database;
let running: RunningServer;
let port: number;
let token: string;

function start(allowedHosts: string[] = []) {
  dir = mkdtempSync(join(tmpdir(), 'omni-r2-'));
  db = openDatabase(join(dir, DB_FILE));
  running = startServer({db, port: 0, hostname: '127.0.0.1', tickler: false, allowedHosts});
  port = running.server.port!;
  token = createToken(db, findAccount(db, 'work')!.id, 'you', new Date().toISOString());
}

afterEach(async () => {
  await running.stop();
  db.close();
  rmSync(dir, {recursive: true, force: true});
});

const session = (host: string) =>
  fetch(`http://127.0.0.1:${port}/api/session`, {headers: {host, authorization: `Bearer ${token}`}});

const addTask = (headers: Record<string, string>) =>
  fetch(`http://127.0.0.1:${port}/api/cli`, {
    method: 'POST',
    headers: {'content-type': 'application/json', authorization: `Bearer ${token}`, ...headers},
    body: JSON.stringify({argv: ['add', 'From the web', '-t', 'agent', '--next']}),
  });

const login = (account: string, pin?: string) =>
  fetch(`http://127.0.0.1:${port}/api/session`, {
    method: 'POST',
    headers: {'content-type': 'application/json'},
    body: JSON.stringify(pin === undefined ? {account} : {account, pin}),
  });

test('Host: evil.example is refused with 403, naming the host and how to allow it', async () => {
  start();
  const response = await session('evil.example');
  expect(response.status).toBe(403);
  const body = await response.json();
  expect(body.ok).toBe(false);
  expect(body.error).toContain('"evil.example"');
  expect(body.error).toContain('omni serve --allowed-hosts evil.example');
  expect(body.error).toContain('OMNI_ALLOWED_HOSTS');
});

test('the refusal reaches every checked route, even ones that do not exist', async () => {
  start();
  for (const path of ['/api/accounts', '/api/events', '/api/tasks', '/nothing-here']) {
    expect((await fetch(`http://127.0.0.1:${port}${path}`, {headers: {host: 'evil.example'}})).status).toBe(403);
  }
  expect((await fetch(`http://127.0.0.1:${port}/nothing-here`)).status).toBe(404);
});

test('a foreign host with our port, or a loopback name on another port or none, is refused', async () => {
  start();
  expect((await session(`evil.example:${port}`)).status).toBe(403);
  expect((await session(`localhost:${port + 1}`)).status).toBe(403);
  expect((await session('localhost')).status).toBe(403);
});

test('localhost, 127.0.0.1 and [::1] with our port are answered', async () => {
  start();
  for (const host of [`localhost:${port}`, `127.0.0.1:${port}`, `[::1]:${port}`, `LOCALHOST:${port}`]) {
    const response = await session(host);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ok: true, account: 'work', actor: 'you'});
  }
});

test('an allowed host is answered, with or without the port', async () => {
  start(['omni.lan', 'box.lan:8080']);
  expect((await session(`omni.lan:${port}`)).status).toBe(200);
  expect((await session('box.lan:8080')).status).toBe(200);
  expect((await session(`other.lan:${port}`)).status).toBe(403);
});

test('a POST with a foreign Origin is refused with 403 and changes nothing', async () => {
  start();
  const response = await addTask({origin: 'http://evil.example'});
  expect(response.status).toBe(403);
  expect((await response.json()).error).toContain('"evil.example"');
  // The same check for a loopback name on another port.
  expect((await addTask({origin: `http://localhost:${port + 1}`})).status).toBe(403);
  const count = db.query('SELECT COUNT(*) AS n FROM tasks').get() as {n: number};
  expect(count.n).toBe(0);
});

test('a POST with a matching Origin, or none, is answered', async () => {
  start(['omni.lan']);
  const cases: Array<Record<string, string>> = [{}, {origin: `http://localhost:${port}`}, {origin: `http://127.0.0.1:${port}`}, {origin: `http://omni.lan:${port}`, host: `omni.lan:${port}`}];
  for (const headers of cases) {
    const response = await addTask(headers);
    expect(response.status).toBe(200);
  }
  const count = db.query('SELECT COUNT(*) AS n FROM tasks').get() as {n: number};
  expect(count.n).toBe(4);
});

test('a GET with a foreign Origin is answered (reads are not cross-origin writes)', async () => {
  start();
  const response = await fetch(`http://127.0.0.1:${port}/api/session`, {
    headers: {origin: 'http://evil.example', authorization: `Bearer ${token}`},
  });
  expect(response.status).toBe(200);
});

test('the web app bundle at / is served by Bun directly and is not checked', async () => {
  start();
  const response = await fetch(`http://127.0.0.1:${port}/`, {headers: {host: 'evil.example'}});
  expect(response.status).toBe(200);
  expect(response.headers.get('content-type')).toContain('text/html');
});

test('checkRequest and acceptedHosts, directly', () => {
  expect(acceptedHosts(7777, [])).toEqual(['localhost:7777', '127.0.0.1:7777', '[::1]:7777']);
  const req = (host: string, method = 'GET', origin?: string) =>
    new Request('http://x/', {method, headers: {host, ...(origin === undefined ? {} : {origin})}});
  expect(checkRequest(req('localhost:7777'), 7777, [])).toBeUndefined();
  expect(checkRequest(req('evil.example'), 7777, [])).toContain('evil.example');
  expect(checkRequest(req('localhost:7777', 'POST', 'http://evil.example'), 7777, [])).toContain('cross-origin');
  expect(checkRequest(req('localhost:7777', 'POST', 'http://localhost:7777'), 7777, [])).toBeUndefined();
});

test('a sixth wrong PIN inside a minute from one address is refused with 429', async () => {
  start();
  setPin(db, findAccount(db, 'work')!.id, '4821');
  for (let i = 0; i < 5; i++) expect((await login('work', '0000')).status).toBe(403);
  const sixth = await login('work', '0000');
  expect(sixth.status).toBe(429);
  expect(Number(sixth.headers.get('retry-after'))).toBeGreaterThan(0);
  expect((await sixth.json()).error).toContain('too many wrong PINs');
  // Even the right PIN waits: the limit is on the address, not on the guess.
  expect((await login('work', '4821')).status).toBe(429);
});

test('right PINs and PIN-less accounts do not count towards the limit', async () => {
  start();
  setPin(db, findAccount(db, 'work')!.id, '4821');
  for (let i = 0; i < 7; i++) expect((await login('work', '4821')).status).toBe(200);
  for (let i = 0; i < 7; i++) expect((await login('home')).status).toBe(200);
});

test('the limiter forgets failures older than a minute', () => {
  let clock = 0;
  const limiter = new PinLimiter(5, 60_000, () => clock);
  for (let i = 0; i < 5; i++) limiter.fail('1.2.3.4');
  expect(limiter.blocked('1.2.3.4')).toBe(60);
  expect(limiter.blocked('5.6.7.8')).toBeUndefined();
  clock = 60_001;
  expect(limiter.blocked('1.2.3.4')).toBeUndefined();
});

test('the omni CLI and the omni-work skill flow still work over loopback (localhost and 127.0.0.1)', async () => {
  start();
  const agent = createToken(db, findAccount(db, 'work')!.id, 'agent:claude-code', new Date().toISOString());
  const cli = async (url: string, tok: string, args: string[]) => {
    const proc = Bun.spawn(['bun', 'run', 'src/cli.ts', ...args], {
      env: {...process.env, OMNI_URL: url, OMNI_TOKEN: tok, NO_COLOR: '1'},
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    return {code, stdout, stderr};
  };
  for (const url of [`http://localhost:${port}`, `http://127.0.0.1:${port}`]) {
    const added = await cli(url, token, ['add', `Fix printer via ${url}`, '-t', 'agent', '--next', '--json']);
    expect({code: added.code, stderr: added.stderr}).toEqual({code: 0, stderr: ''});
  }
  const next = await cli(`http://127.0.0.1:${port}`, agent, ['next', 'agent,ai', '--json']);
  expect(next.code).toBe(0);
  const tasks = JSON.parse(next.stdout) as Array<{id: string}>;
  expect(tasks).toHaveLength(2);
  const submitted = await cli(`http://localhost:${port}`, agent, ['submit', tasks[0]!.id, '--note', 'done over loopback', '--json']);
  expect(submitted.code).toBe(0);
  expect(JSON.parse(submitted.stdout).ok).toBe(true);
});
