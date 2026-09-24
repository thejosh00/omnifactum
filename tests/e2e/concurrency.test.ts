/**
 * The headline guarantee: a person and agents can work at the same time without losing
 * each other's changes.
 *
 * These start a real server and hit it from genuinely concurrent OS processes running
 * the real CLI, alongside a "browser" using the JSON API — nothing simulated. A tag
 * added by one writer must survive every other writer; a note from every writer must
 * reach the log; a completion must happen exactly once; and an edit made from a stale
 * copy must be refused rather than silently win.
 */
import {afterEach, describe, expect, test} from 'bun:test';
import {join} from 'node:path';
import {Database} from 'bun:sqlite';
import {EXIT_BUSY, EXIT_OK} from '../../src/commands/context.ts';
import {DB_FILE, openDatabase} from '../../src/db/database.ts';
import {startServer} from '../../src/server/server.ts';
import {makeVault, type Vault} from '../helpers/vault.ts';
import {omni, omniSpawn, serveFor, type CliResult, type TestServer} from '../helpers/cli.ts';

const NOW = '2026-09-12T11:03:00Z';
/** Enough writers to lose something if the transactions were wrong, few enough to stay quick. */
const WRITERS = 12;

let vault: Vault | undefined;
let server: TestServer | undefined;

async function setup(): Promise<{v: Vault; s: TestServer; person: string; agent: (n: number) => string}> {
  vault = makeVault({layout: false});
  server = serveFor(vault.dir);
  const s = server;
  return {v: vault, s, person: s.token('you'), agent: n => s.token(`agent:writer-${n}`)};
}

afterEach(async () => {
  await server?.stop();
  server = undefined;
  vault?.cleanup();
  vault = undefined;
});

function show(v: Vault, ref: string) {
  return omni(['show', ref, '--json'], {dir: v.dir, now: NOW}).then(
    r => JSON.parse(r.stdout) as {state: string; tags: string[]; log: Array<{actor: string; text: string}>; version: number},
  );
}

function api(s: TestServer, token: string, method: string, path: string, body?: unknown): Promise<Response> {
  return fetch(`${s.url}${path}`, {
    method,
    headers: {authorization: `Bearer ${token}`, 'content-type': 'application/json'},
    ...(body === undefined ? {} : {body: JSON.stringify(body)}),
  });
}

describe('concurrent writers to the same task', () => {
  test('every tag survives, none is lost — agents at a shell and a person in a browser', async () => {
    const {v, s, person, agent} = await setup();
    await omni(['add', 'Shared task', '--next'], {dir: v.dir, now: NOW});

    const agents = Array.from({length: WRITERS}, (_, n) =>
      omniSpawn(['tag', 'shared-task', `+t${n}`], {server: s, token: agent(n)}),
    );
    const browser = Array.from({length: WRITERS}, (_, n) =>
      api(s, person, 'POST', '/api/tasks/shared-task/tags', {add: [`b${n}`]}),
    );
    const results = await Promise.all([...agents, ...browser]);

    for (const result of results) {
      const code = result instanceof Response ? (result.ok ? 0 : result.status) : (result as CliResult).code;
      expect(code).toBe(EXIT_OK);
    }
    const task = await show(v, 'shared-task');
    const expected = [
      ...Array.from({length: WRITERS}, (_, n) => `t${n}`),
      ...Array.from({length: WRITERS}, (_, n) => `b${n}`),
    ];
    expect([...task.tags].sort()).toEqual(expected.sort());
    expect(task.version).toBe(1 + WRITERS * 2);
  });

  test('a note from every writer reaches the log, each credited to its author', async () => {
    const {v, s, agent} = await setup();
    await omni(['add', 'Shared task', '--next'], {dir: v.dir, now: NOW});

    await Promise.all(
      Array.from({length: WRITERS}, (_, n) =>
        omniSpawn(['note', 'shared-task', `note ${n}`], {server: s, token: agent(n)}),
      ),
    );

    const task = await show(v, 'shared-task');
    expect(task.log).toHaveLength(WRITERS);
    expect(task.log.map(e => `${e.actor} ${e.text}`).sort()).toEqual(
      Array.from({length: WRITERS}, (_, n) => `agent:writer-${n} note ${n}`).sort(),
    );
  });
});

describe('concurrent completion of the same task', () => {
  test('exactly one succeeds and the rest say so clearly', async () => {
    const {v, s} = await setup();
    await omni(['add', 'Finish once', '--next'], {dir: v.dir, now: NOW});

    const people = Array.from({length: WRITERS}, () => s.token('you'));
    const results = await Promise.all(
      people.map(token => omniSpawn(['done', 'finish-once', '--json'], {server: s, token})),
    );

    const succeeded = results.filter(r => r.code === EXIT_OK);
    expect(succeeded).toHaveLength(1);
    for (const failed of results.filter(r => r.code !== EXIT_OK)) {
      expect(JSON.parse(failed.stdout)).toMatchObject({ok: false, error: '"Finish once" is already done'});
    }
    const task = await show(v, 'finish-once');
    expect(task.log.filter(e => e.text === 'Completed.')).toHaveLength(1);
  });
});

describe('concurrent creation', () => {
  test('tasks with the same title all survive, each with its own stem', async () => {
    const {v, s, person} = await setup();

    await Promise.all(
      Array.from({length: WRITERS}, () => omniSpawn(['add', 'Same title'], {server: s, token: person})),
    );

    const stems = v.list();
    expect(stems).toHaveLength(WRITERS);
    expect(new Set(stems).size).toBe(WRITERS);
  });
});

describe('an edit made from a stale copy', () => {
  test('is refused with the current task, rather than overwriting what an agent did', async () => {
    const {v, s, person, agent} = await setup();
    await omni(['add', 'Draft the memo', '--next'], {dir: v.dir, now: NOW});
    const opened = await show(v, 'draft-the-memo');

    // While the person is typing, an agent records progress.
    await omniSpawn(['note', 'draft-the-memo', 'outline done'], {server: s, token: agent(1)});

    const stale = await fetch(`${s.url}/api/tasks/draft-the-memo`, {
      method: 'PATCH',
      headers: {authorization: `Bearer ${person}`, 'if-match': String(opened.version)},
      body: JSON.stringify({body: 'my draft'}),
    });
    expect(stale.status).toBe(409);
    const refused = (await stale.json()) as {task: {version: number; log: unknown[]}};
    expect(refused.task.log).toHaveLength(1);

    // Re-applied against what is there now, it goes through and keeps the agent's note.
    const retried = await fetch(`${s.url}/api/tasks/draft-the-memo`, {
      method: 'PATCH',
      headers: {authorization: `Bearer ${person}`, 'if-match': String(refused.task.version)},
      body: JSON.stringify({body: 'my draft'}),
    });
    expect(retried.status).toBe(200);
    const after = await show(v, 'draft-the-memo');
    expect(after.log.map(e => e.text)).toEqual(['outline done']);
  });
});

describe('a database someone else is holding', () => {
  test('a write reports busy as JSON on stdout, with nothing on stderr', async () => {
    vault = makeVault({layout: false});
    const path = join(vault.dir, DB_FILE);
    const db = openDatabase(path, {busyTimeoutMs: 50});
    const running = startServer({db, port: 0, hostname: '127.0.0.1', tickler: false});
    const token = (await omni(['account', 'token', 'work', 'you'], {dir: vault.dir})).stdout.trim();

    // Another process mid-write, holding the write lock.
    const other = new Database(path);
    other.exec('BEGIN IMMEDIATE');
    try {
      const result = await omniSpawn(['add', 'Blocked', '--json'], {
        server: {url: running.url} as TestServer,
        token,
      });
      expect(result.code).toBe(EXIT_BUSY);
      expect(result.stderr).toBe('');
      expect(JSON.parse(result.stdout)).toMatchObject({ok: false, code: EXIT_BUSY});
    } finally {
      other.exec('ROLLBACK');
      other.close();
      await running.stop();
      db.close();
    }
  });

  test('an unreachable server is busy too, so an agent knows to retry', async () => {
    const result = await omniSpawn(['next', '--json'], {
      server: {url: 'http://127.0.0.1:1'} as TestServer,
      token: 'omni_nothing',
    });
    expect(result.code).toBe(EXIT_BUSY);
    expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout)).toMatchObject({ok: false, code: EXIT_BUSY});
  });
});
