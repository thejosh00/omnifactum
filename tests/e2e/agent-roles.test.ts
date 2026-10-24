/**
 * Who may write: every route and every command declares it, and anything undeclared is
 * refused for everyone (R1).
 *
 * The enumeration tests walk every registered route and command with an agent's token
 * and compare what happened with the table below. Adding a route or command means adding
 * a row here, and one without a role declaration fails outright.
 */
import {afterEach, describe, expect, test} from 'bun:test';
import {makeVault, type Vault} from '../helpers/vault.ts';
import {databaseFor, omni, omniSpawn, serveFor, type TestServer} from '../helpers/cli.ts';
import {ROUTES} from '../../src/server/api.ts';
import {commandRoles} from '../../src/commands/run.ts';
import {createToken} from '../../src/db/auth.ts';
import {findAccount} from '../../src/db/database.ts';

const NOW = '2026-09-12T11:03:00Z';
const AGENT = 'agent:claude-code';
const TASK = 'fix-printer-driver';

let vault: Vault | undefined;
let server: TestServer | undefined;

afterEach(async () => {
  await server?.stop();
  server = undefined;
  vault?.cleanup();
  vault = undefined;
});

async function setup() {
  vault = makeVault({layout: false});
  server = serveFor(vault.dir, NOW);
  const v = vault;
  const s = server;
  await omni(['add', 'Fix printer driver', '-t', 'agent', '--next'], {dir: v.dir, now: NOW});
  const call = async (token: string, method: string, path: string, body?: unknown) => {
    const response = await fetch(`${s.url}${path}`, {
      method,
      headers: {authorization: `Bearer ${token}`, 'content-type': 'application/json'},
      ...(body === undefined ? {} : {body: JSON.stringify(body)}),
    });
    return {status: response.status, json: (await response.json()) as Record<string, unknown>};
  };
  return {v, s, you: s.token('you'), agent: s.token(AGENT), call};
}

/** The CLI as an agent's token runs it: the base store's actor is the agent. */
const asAgent = (v: Vault, args: string[]) => omni([...args, '--json'], {dir: v.dir, now: NOW, as: AGENT});
const asYou = (v: Vault, args: string[]) => omni([...args, '--json'], {dir: v.dir, now: NOW});

const show = async (v: Vault, ref = TASK) => JSON.parse((await asYou(v, ['show', ref])).stdout) as Record<string, unknown>;

const wasRefused = (stdout: string) => /"refused":\s*true/.test(stdout);

// --- the declared tables ----------------------------------------------------------

type Expect = 'allowed' | 'refused';

/** Every route, what an agent gets, and a body that would otherwise work. */
const ROUTE_TABLE: Record<string, {agent: Expect; body?: unknown}> = {
  'GET /api/tasks': {agent: 'allowed'},
  'POST /api/tasks': {agent: 'allowed', body: {title: 'From HTTP', state: 'next'}},
  'GET /api/tasks/:ref': {agent: 'allowed'},
  'PATCH /api/tasks/:ref': {agent: 'allowed', body: {body: 'More detail'}},
  'DELETE /api/tasks/:ref': {agent: 'refused'},
  'POST /api/tasks/:ref/move': {agent: 'allowed', body: {to: 'someday'}},
  'POST /api/tasks/:ref/done': {agent: 'refused', body: {}},
  'POST /api/tasks/:ref/submit': {agent: 'allowed', body: {note: 'did it'}},
  'POST /api/tasks/:ref/note': {agent: 'allowed', body: {note: 'progress'}},
  'POST /api/tasks/:ref/tags': {agent: 'allowed', body: {add: ['http']}},
  'POST /api/tasks/:ref/place': {agent: 'refused', body: {before: TASK}},
  'POST /api/tasks/:ref/clarify': {agent: 'allowed', body: {outcome: {kind: 'file', state: 'next', tags: []}}},
  'GET /api/projects': {agent: 'allowed'},
  'POST /api/projects': {agent: 'refused', body: {title: 'Kitchen', outcome: 'A kitchen'}},
  'GET /api/projects/:ref': {agent: 'allowed'},
  'PATCH /api/projects/:ref': {agent: 'refused', body: {outcome: 'x'}},
  'POST /api/projects/:ref/rename': {agent: 'refused', body: {title: 'x'}},
  'POST /api/projects/:ref/move': {agent: 'refused', body: {to: 'done'}},
  'GET /api/ticklers': {agent: 'allowed'},
  'POST /api/ticklers': {agent: 'refused', body: {title: 'Water bill', schedule: 'monthly:15'}},
  'PATCH /api/ticklers/:ref': {agent: 'refused', body: {title: 'x'}},
  'DELETE /api/ticklers/:ref': {agent: 'refused'},
  'GET /api/weekly': {agent: 'allowed'},
  'POST /api/weekly/record': {agent: 'refused', body: {}},
  'GET /api/tags': {agent: 'allowed'},
  'GET /api/agents': {agent: 'allowed'},
  'GET /api/agents/:ref': {agent: 'allowed'},
  'POST /api/cli': {agent: 'allowed', body: {argv: ['tags', '--json']}},
};

/**
 * Every command, with argv an agent might send and what it gets. A command that is open
 * to agents in some forms lists those forms too.
 */
const COMMAND_TABLE: Record<string, Array<[string[], Expect]>> = {
  add: [[['add', 'Another task', '--next'], 'allowed']],
  list: [[['list'], 'allowed']],
  inbox: [[['inbox'], 'allowed']],
  next: [[['next', 'agent'], 'allowed']],
  waiting: [[['waiting'], 'allowed']],
  someday: [[['someday'], 'allowed']],
  review: [[['review'], 'allowed']],
  done: [
    [['done', TASK], 'refused'],
    [['done', TASK, '--force'], 'refused'],
  ],
  submit: [[['submit', TASK, '--note', 'did it'], 'allowed']],
  weekly: [
    [['weekly'], 'allowed'],
    [['weekly', '--record'], 'refused'],
  ],
  due: [[['due'], 'allowed']],
  mv: [
    [['mv', TASK, 'waiting', '--note', 'blocked'], 'allowed'],
    [['mv', TASK, 'done'], 'refused'],
  ],
  note: [
    [['note', TASK, 'progress'], 'allowed'],
    [['note', TASK, 'progress', '--force=yes'], 'refused'],
  ],
  rm: [
    [['rm', TASK, '--yes'], 'refused'],
    [['rm', TASK, '--force'], 'refused'],
  ],
  tag: [[['tag', TASK, '+cli'], 'allowed']],
  tags: [[['tags'], 'allowed']],
  show: [[['show', TASK], 'allowed']],
  project: [
    [['project', 'list'], 'allowed'],
    [['project', 'show', 'nothing'], 'allowed'],
    [['project', 'add', 'Kitchen', '-o', 'A kitchen'], 'refused'],
    [['project', 'done', 'kitchen'], 'refused'],
  ],
  tickler: [
    [['tickler', 'list'], 'allowed'],
    [['tickler', 'add', 'Water bill', '--monthly', '15'], 'refused'],
    [['tickler', 'rm', 'water-bill', '--yes'], 'refused'],
  ],
  agents: [[['agents'], 'allowed']],
};

describe('every route and command declares who may use it', () => {
  test('every non-GET route has a role declaration, and the table names every route', () => {
    const registered = ROUTES.map(route => `${route.method} ${route.path}`);
    expect(registered.sort()).toEqual(Object.keys(ROUTE_TABLE).sort());
    for (const route of ROUTES) {
      if (route.method !== 'GET') expect({route: route.path, method: route.method, allow: route.allow}).toEqual({
        route: route.path,
        method: route.method,
        allow: expect.any(Array),
      });
    }
  });

  test('every command has a role declaration, and the table names every command', () => {
    const roles = commandRoles();
    expect(Object.keys(roles).sort()).toEqual(Object.keys(COMMAND_TABLE).sort());
    for (const [name, allow] of Object.entries(roles)) {
      expect({name, declared: Array.isArray(allow)}).toEqual({name, declared: true});
    }
  });

  test('each route, called with an agent token, does what the table says', async () => {
    const {v, agent, call} = await setup();
    for (const route of ROUTES) {
      const key = `${route.method} ${route.path}`;
      const row = ROUTE_TABLE[key]!;
      // Each write starts from the task in next, so the order does not matter.
      await asYou(v, ['mv', TASK, 'next']);
      const path = route.path.replace(':ref', route.path.startsWith('/api/tasks') ? TASK : 'nothing');
      const result = await call(agent, route.method, path, route.method === 'GET' || route.method === 'DELETE' ? undefined : row.body);
      const got: Expect = result.status === 403 && result.json['refused'] === true ? 'refused' : 'allowed';
      expect({key, got}).toEqual({key, got: row.agent});
      if (got === 'refused') expect(result.json).toMatchObject({ok: false, code: 2});
      if (row.agent === 'allowed' && route.path.startsWith('/api/tasks/:ref')) {
        expect({key, ok: result.json['ok']}).toEqual({key, ok: true});
      }
    }
  });

  test('each command, run with an agent token, does what the table says', async () => {
    const {v} = await setup();
    for (const [name, cases] of Object.entries(COMMAND_TABLE)) {
      for (const [argv, expected] of cases) {
        await asYou(v, ['mv', TASK, 'next']);
        const result = await asAgent(v, argv);
        const got: Expect = wasRefused(result.stdout) ? 'refused' : 'allowed';
        expect({name, argv, got}).toEqual({name, argv, got: expected});
        if (got === 'refused') expect(result.code).toBe(2);
      }
    }
  });

  test('a command name the dispatcher does not know is refused, not run', async () => {
    const {v} = await setup();
    expect((await asAgent(v, ['frobnicate'])).code).toBe(2);
  });
});

describe('an agent cannot finish or delete work', () => {
  test('mv … done, done --force and rm --yes exit 2, and the task is unchanged', async () => {
    const {v} = await setup();
    const before = await show(v);
    for (const argv of [
      ['mv', TASK, 'done'],
      ['done', TASK, '--force'],
      ['rm', TASK, '--yes'],
    ]) {
      const result = await asAgent(v, argv);
      expect({argv, code: result.code}).toEqual({argv, code: 2});
      expect(JSON.parse(result.stdout)).toMatchObject({ok: false, code: 2, refused: true});
    }
    expect(await show(v)).toEqual(before);
  });

  test('through the real client and server, mv … done exits 2 for an agent token', async () => {
    const {v, s, agent} = await setup();
    const before = await show(v);
    const result = await omniSpawn(['mv', TASK, 'done', '--json'], {server: s, token: agent});
    expect(result.code).toBe(2);
    expect(await show(v)).toEqual(before);
  });

  test('DELETE, done, move to done, clarify-discard and force return the refused envelope', async () => {
    const {v, agent, call} = await setup();
    const before = await show(v);
    const attempts: Array<[string, string, unknown?]> = [
      ['DELETE', `/api/tasks/${TASK}`],
      ['POST', `/api/tasks/${TASK}/done`, {force: true}],
      ['POST', `/api/tasks/${TASK}/move`, {to: 'done'}],
      ['POST', `/api/tasks/${TASK}/move`, {to: 'done', force: true}],
      ['POST', `/api/tasks/${TASK}/clarify`, {outcome: {kind: 'discard'}}],
      ['POST', `/api/tasks/${TASK}/note`, {note: 'x', force: true}],
      ['POST', '/api/tasks', {title: 'Sneaky', state: 'done'}],
      ['POST', '/api/cli', {argv: ['mv', TASK, 'done', '--json']}],
      ['POST', '/api/cli', {argv: ['rm', TASK, '--yes', '--json'], actor: 'you'}],
    ];
    for (const [method, path, body] of attempts) {
      const result = await call(agent, method, path, body);
      if (path === '/api/cli') {
        expect({path, body, code: result.json['code']}).toEqual({path, body, code: 2});
      } else {
        expect({method, path, status: result.status}).toEqual({method, path, status: 403});
        expect(result.json).toMatchObject({ok: false, code: 2, refused: true});
      }
    }
    expect(await show(v)).toEqual(before);
    expect(JSON.parse((await asYou(v, ['list', '--all'])).stdout)).toHaveLength(1);
  });

  test('recording the weekly review and the tickler routes are refused', async () => {
    const {v, you, agent, call} = await setup();
    const created = await call(you, 'POST', '/api/ticklers', {title: 'Water bill', schedule: 'monthly:15'});
    const id = (created.json['tickler'] as {id: string}).id;
    const weeklyBefore = (await call(you, 'GET', '/api/weekly')).json;

    for (const [method, path, body] of [
      ['POST', '/api/weekly/record', {}],
      ['POST', '/api/ticklers', {title: 'Another', schedule: 'monthly:16'}],
      ['PATCH', `/api/ticklers/${id}`, {title: 'Renamed'}],
      ['DELETE', `/api/ticklers/${id}`, undefined],
    ] as const) {
      const result = await call(agent, method, path, body);
      expect({method, path, status: result.status}).toEqual({method, path, status: 403});
      expect(result.json).toMatchObject({ok: false, code: 2, refused: true});
    }
    expect((await asAgent(v, ['weekly', '--record'])).code).toBe(2);
    expect((await asAgent(v, ['tickler', 'add', 'Another', '--monthly', '16'])).code).toBe(2);
    expect((await asAgent(v, ['tickler', 'rm', id, '--yes'])).code).toBe(2);

    const ticklers = (await call(you, 'GET', '/api/ticklers')).json['ticklers'] as Array<{title: string}>;
    expect(ticklers.map(t => t.title)).toEqual(['Water bill']);
    expect((await call(you, 'GET', '/api/weekly')).json).toEqual(weeklyBefore);
  });
});

describe('what the omni-work skill does still works for an agent', () => {
  test('add, note, mv waiting and submit succeed on the CLI', async () => {
    const {v} = await setup();
    expect((await asAgent(v, ['add', 'Found while working', '--next'])).code).toBe(0);
    expect((await asAgent(v, ['note', TASK, 'Reproduced it'])).code).toBe(0);
    expect((await asAgent(v, ['mv', TASK, 'waiting', '--note', 'needs the portal login'])).code).toBe(0);
    expect((await show(v))['state']).toBe('waiting');
    await asYou(v, ['mv', TASK, 'next']);
    expect((await asAgent(v, ['submit', TASK, '--note', 'Installed PPD 4.2'])).code).toBe(0);
    expect((await show(v))['state']).toBe('review');
  });

  test('the same over HTTP and through the real client', async () => {
    const {v, s, agent, call} = await setup();
    expect((await call(agent, 'POST', '/api/tasks', {title: 'From HTTP'})).status).toBe(201);
    expect((await call(agent, 'POST', `/api/tasks/${TASK}/note`, {note: 'progress'})).json['ok']).toBe(true);
    expect((await call(agent, 'POST', `/api/tasks/${TASK}/move`, {to: 'waiting'})).json['ok']).toBe(true);
    const spawned = await omniSpawn(['submit', TASK, '--note', 'done it', '--json'], {server: s, token: agent});
    expect(spawned.code).toBe(0);
    expect((await show(v))['state']).toBe('review');
  });
});

describe('a person is never stopped', () => {
  test('every command the agent is refused succeeds with a you token', async () => {
    const {v} = await setup();
    expect((await asYou(v, ['mv', TASK, 'done'])).code).toBe(0);
    expect((await show(v))['state']).toBe('done');
    await asYou(v, ['mv', TASK, 'next']);
    expect((await asYou(v, ['done', TASK, '--force'])).code).toBe(0);
    expect((await asYou(v, ['weekly', '--record'])).code).toBe(0);
    const tickler = await asYou(v, ['tickler', 'add', 'Water bill', '--monthly', '15']);
    expect(tickler.code).toBe(0);
    const id = (JSON.parse(tickler.stdout) as {tickler: {id: string}}).tickler.id;
    expect((await asYou(v, ['tickler', 'rm', id, '--yes'])).code).toBe(0);
    expect((await asYou(v, ['add', 'Mine', '--next'])).code).toBe(0);
    expect((await asYou(v, ['note', 'mine', 'a note'])).code).toBe(0);
    expect((await asYou(v, ['mv', 'mine', 'waiting'])).code).toBe(0);
    expect((await asYou(v, ['submit', 'mine', '--note', 'did it'])).code).toBe(0);
    expect((await asYou(v, ['rm', TASK, '--yes'])).code).toBe(0);
  });

  test('every route the agent is refused succeeds with a you token', async () => {
    const {you, call, s} = await setup();
    const ok = async (method: string, path: string, body?: unknown) => {
      const result = await call(you, method, path, body);
      expect({method, path, body, ok: result.json['ok']}).toEqual({method, path, body, ok: true});
      return result.json;
    };
    await ok('POST', '/api/tasks', {title: 'Second', state: 'next'});
    await ok('POST', '/api/tasks/second/note', {note: 'x'});
    await ok('POST', '/api/tasks/second/move', {to: 'waiting'});
    await ok('POST', '/api/tasks/second/submit', {note: 'did it'});
    await ok('POST', '/api/tasks/second/move', {to: 'done'});
    await ok('POST', `/api/tasks/${TASK}/done`, {});
    await ok('DELETE', `/api/tasks/${TASK}`);
    await ok('POST', '/api/tasks', {title: 'Third'});
    await ok('POST', '/api/tasks/third/clarify', {outcome: {kind: 'discard'}});
    await ok('POST', '/api/weekly/record', {});
    const created = await ok('POST', '/api/ticklers', {title: 'Water bill', schedule: 'monthly:15'});
    const id = (created['tickler'] as {id: string}).id;
    await ok('PATCH', `/api/ticklers/${id}`, {title: 'Water'});
    await ok('DELETE', `/api/ticklers/${id}`);
    const cli = await call(you, 'POST', '/api/cli', {argv: ['add', 'Via cli', '--json']});
    expect(cli.json['code']).toBe(0);
    const spawned = await omniSpawn(['mv', 'via-cli', 'done', '--json'], {server: s, token: you});
    expect(spawned.code).toBe(0);
  });
});

describe('actors are checked when a token is made and when it is used', () => {
  test('createToken refuses an actor that is neither you nor agent:<name>', async () => {
    const {v} = await setup();
    const db = databaseFor(v.dir);
    const work = findAccount(db, 'work')!.id;
    for (const actor of ['claude', 'Agent:X', 'agent:', 'agent:Has Space', 'you2', 'agentclaude']) {
      expect(() => createToken(db, work, actor, NOW)).toThrow(/"you" or "agent:<name>"/);
    }
    expect(createToken(db, work, 'agent:claude-code', NOW)).toMatch(/^omni_/);
    expect(createToken(db, work, 'you', NOW)).toMatch(/^omni_/);
  });

  test('omni account token refuses one with exit 2', async () => {
    const {v} = await setup();
    await server!.stop();
    server = undefined;
    const result = await omni(['account', 'token', 'work', 'claude'], {dir: v.dir, now: NOW});
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('agent:<name>');
  });

  test('an existing token with such an actor is refused, with how to re-issue it', async () => {
    const {v, s} = await setup();
    const db = databaseFor(v.dir);
    db.query('INSERT INTO tokens (token, account_id, actor, created) VALUES (?, ?, ?, ?)').run(
      'omni_legacy',
      findAccount(db, 'work')!.id,
      'claude',
      NOW,
    );
    const before = await show(v);
    for (const [method, path, body] of [
      ['GET', '/api/tasks', undefined],
      ['POST', `/api/tasks/${TASK}/done`, {}],
      ['POST', '/api/cli', {argv: ['rm', TASK, '--yes']}],
    ] as const) {
      const response = await fetch(`${s.url}${path}`, {
        method,
        headers: {authorization: 'Bearer omni_legacy', 'content-type': 'application/json'},
        ...(body === undefined ? {} : {body: JSON.stringify(body)}),
      });
      expect(response.status).toBe(403);
      const json = (await response.json()) as {ok: boolean; code: number; error: string};
      expect(json).toMatchObject({ok: false, code: 2});
      expect(json.error).toContain('"claude"');
      expect(json.error).toContain('omni account token work agent:<name>');
    }
    expect(await show(v)).toEqual(before);
  });
});
