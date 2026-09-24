/**
 * Tickler items over HTTP and the CLI: both reach the same store, and both fire.
 */
import {afterEach, describe, expect, test} from 'bun:test';
import {makeVault, type Vault} from '../helpers/vault.ts';
import {omni, serveFor, type TestServer} from '../helpers/cli.ts';

// Saturday 2026-09-12 in Chicago.
const NOW = '2026-09-12T15:03:00Z';

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
  return {v: vault, call};
}

afterEach(async () => {
  await server?.stop();
  server = undefined;
  vault?.cleanup();
  vault = undefined;
});

describe('tickler items over HTTP', () => {
  test('add, list, edit and delete', async () => {
    const {call} = setup();
    expect((await call('POST', '/api/ticklers', {title: 'Water bill', schedule: 'monthly:99'})).status).toBe(400);

    const created = await call('POST', '/api/ticklers', {title: 'Water bill', schedule: 'monthly:15'});
    expect(created.status).toBe(201);
    expect(created.body['fired']).toBe(false);
    const item = created.body['tickler'];
    expect(item).toMatchObject({title: 'Water bill', next_on: '2026-09-15', description: 'monthly on the 15th'});

    const listed = await call('GET', '/api/ticklers');
    expect(listed.body['ticklers']).toHaveLength(1);

    const patched = await call('PATCH', `/api/ticklers/${item.id}`, {schedule: {kind: 'weekly', weekday: 1}}, {'if-match': String(item.version)});
    expect(patched.body['tickler']).toMatchObject({next_on: '2026-09-14', schedule_text: 'weekly:mon'});

    const stale = await call('PATCH', `/api/ticklers/${item.id}`, {title: 'Old'}, {'if-match': String(item.version)});
    expect(stale.status).toBe(409);

    expect((await call('DELETE', `/api/ticklers/${item.id}`)).status).toBe(200);
    expect((await call('GET', '/api/ticklers')).body['ticklers']).toEqual([]);
  });

  test('one due today lands in next straight away, tagged #tickler', async () => {
    const {call} = setup();
    const created = await call('POST', '/api/ticklers', {title: 'Check the smoke alarms', schedule: 'weekly:sat'});
    expect(created.body['fired']).toBe(true);

    const next = await call('GET', '/api/tasks?state=next');
    expect(next.body['tasks']).toEqual([expect.objectContaining({title: 'Check the smoke alarms', tags: ['tickler']})]);
  });
});

describe('omni tickler', () => {
  test('add, list and rm', async () => {
    const {v} = setup();
    const added = await omni(['tickler', 'add', 'Renew the passport', '--on', '2027-03-01', '--json'], {dir: v.dir, now: NOW});
    expect(added.code).toBe(0);
    const id = JSON.parse(added.stdout).tickler.id as string;

    const listed = JSON.parse((await omni(['tickler', 'list', '--json'], {dir: v.dir, now: NOW})).stdout);
    expect(listed).toEqual([expect.objectContaining({title: 'Renew the passport', next_on: '2027-03-01'})]);

    expect((await omni(['tickler', 'add', 'Nothing', '--json'], {dir: v.dir, now: NOW})).code).not.toBe(0);
    expect((await omni(['tickler', 'rm', id], {dir: v.dir, now: NOW})).code).not.toBe(0);
    expect((await omni(['tickler', 'rm', id, '--yes'], {dir: v.dir, now: NOW})).code).toBe(0);
    expect(JSON.parse((await omni(['tickler', '--json'], {dir: v.dir, now: NOW})).stdout)).toEqual([]);
  });

  test('--every takes a weekday', async () => {
    const {v} = setup();
    const added = await omni(['tickler', 'add', 'Recycling', '--every', 'mon', '--json'], {dir: v.dir, now: NOW});
    expect(JSON.parse(added.stdout).tickler).toMatchObject({description: 'every Monday', next_on: '2026-09-14'});
  });
});
