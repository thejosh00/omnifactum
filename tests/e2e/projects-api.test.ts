/**
 * Managing projects over HTTP, the way the web app does it: the same rules as
 * `omni project`, because both go through `src/db/projects.ts`.
 */
import {afterEach, describe, expect, test} from 'bun:test';
import {makeVault, type Vault} from '../helpers/vault.ts';
import {omni, serveFor, type TestServer} from '../helpers/cli.ts';

const NOW = '2026-09-12T11:03:00Z';

let vault: Vault | undefined;
let server: TestServer | undefined;

function setup() {
  vault = makeVault({layout: false});
  server = serveFor(vault.dir, NOW);
  const token = server.token('you');
  const s = server;
  const call = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const response = await fetch(`${s.url}${path}`, {
      method,
      headers: {authorization: `Bearer ${token}`, 'content-type': 'application/json', ...headers},
      ...(body === undefined ? {} : {body: JSON.stringify(body)}),
    });
    return {status: response.status, body: (await response.json()) as Record<string, any>};
  };
  return {v: vault, s, call};
}

afterEach(async () => {
  await server?.stop();
  server = undefined;
  vault?.cleanup();
  vault = undefined;
});

describe('projects over HTTP', () => {
  test('creating one needs an outcome, and a new one is stalled until it has an action', async () => {
    const {call} = setup();
    expect((await call('POST', '/api/projects', {title: 'Kitchen'})).status).toBe(400);

    const created = await call('POST', '/api/projects', {title: 'Renovate the kitchen', outcome: 'Cooking in it'});
    expect(created.status).toBe(201);
    expect(created.body['project']).toMatchObject({stem: 'renovate-the-kitchen', state: 'active', stalled: true});
  });

  test('renaming repoints every member task, and the old name still resolves', async () => {
    const {v, call} = setup();
    await call('POST', '/api/projects', {title: 'Renovate the kitchen', outcome: 'Cooking in it'});
    await omni(['add', 'Order tiles', '-p', 'renovate-the-kitchen', '--next'], {dir: v.dir, now: NOW});

    const renamed = await call('POST', '/api/projects/renovate-the-kitchen/rename', {title: 'Kitchen refit'});
    expect(renamed.body).toMatchObject({ok: true, previous_stem: 'renovate-the-kitchen', repointed: 1});

    const task = JSON.parse((await omni(['show', 'order-tiles', '--json'], {dir: v.dir, now: NOW})).stdout);
    expect(task.project).toBe('kitchen-refit');
    expect((await call('GET', '/api/projects/renovate-the-kitchen')).body['project'].title).toBe('Kitchen refit');
  });

  test('finishing one with open actions is refused and lists them, unless forced', async () => {
    const {v, call} = setup();
    await call('POST', '/api/projects', {title: 'Kitchen', outcome: 'Done'});
    await omni(['add', 'Order tiles', '-p', 'kitchen', '--next'], {dir: v.dir, now: NOW});

    const refused = await call('POST', '/api/projects/kitchen/move', {to: 'done'});
    expect(refused.status).toBe(409);
    expect(refused.body['open'].map((t: {title: string}) => t.title)).toEqual(['Order tiles']);

    const forced = await call('POST', '/api/projects/kitchen/move', {to: 'done', force: true, note: 'Good enough'});
    expect(forced.body['project']).toMatchObject({state: 'done'});
  });

  test('parking one in someday and bringing it back needs no confirmation', async () => {
    const {call} = setup();
    await call('POST', '/api/projects', {title: 'Kitchen', outcome: 'Done'});
    expect((await call('POST', '/api/projects/kitchen/move', {to: 'someday'})).body['project'].state).toBe('someday');
    expect((await call('POST', '/api/projects/kitchen/move', {to: 'active'})).body['project'].state).toBe('active');
  });

  test('an edit from a stale copy is refused with the project as it is now', async () => {
    const {call} = setup();
    const created = await call('POST', '/api/projects', {title: 'Kitchen', outcome: 'Done'});
    const version = created.body['project'].version;
    await call('PATCH', '/api/projects/kitchen', {outcome: 'Cooking in it'}, {'if-match': String(version)});

    const stale = await call('PATCH', '/api/projects/kitchen', {body: 'my notes'}, {'if-match': String(version)});
    expect(stale.status).toBe(409);
    expect(stale.body['project'].outcome).toBe('Cooking in it');

    const shown = await call('GET', '/api/projects/kitchen');
    expect(shown.body['body']).toBe('');
  });

  test('omni project mv done now checks open actions too, like omni project done', async () => {
    const {v} = setup();
    await omni(['project', 'new', 'Kitchen', '--outcome', 'Done'], {dir: v.dir, now: NOW});
    await omni(['add', 'Order tiles', '-p', 'kitchen', '--next'], {dir: v.dir, now: NOW});

    expect((await omni(['project', 'mv', 'kitchen', 'done'], {dir: v.dir, now: NOW})).code).not.toBe(0);
    expect((await omni(['project', 'mv', 'kitchen', 'done', '--yes'], {dir: v.dir, now: NOW})).code).toBe(0);
  });
});
