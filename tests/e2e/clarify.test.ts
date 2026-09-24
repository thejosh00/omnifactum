/**
 * Filing a clarified item over HTTP: the one write at the end of the walk.
 *
 * The questions are asked in the browser; these check that the answer lands the way the
 * terminal's walk landed it, and that it refuses to act on an item someone else already
 * dealt with.
 */
import {afterEach, describe, expect, test} from 'bun:test';
import {makeVault, type Vault} from '../helpers/vault.ts';
import {omni, serveFor, type TestServer} from '../helpers/cli.ts';

const NOW = '2026-09-12T11:03:00Z';

let vault: Vault | undefined;
let server: TestServer | undefined;

async function setup() {
  vault = makeVault({layout: false});
  server = serveFor(vault.dir, NOW);
  const token = server.token('you');
  const s = server;
  const clarify = (ref: string, body: unknown) =>
    fetch(`${s.url}/api/tasks/${ref}/clarify`, {
      method: 'POST',
      headers: {authorization: `Bearer ${token}`, 'content-type': 'application/json'},
      body: JSON.stringify(body),
    });
  return {v: vault, clarify};
}

afterEach(async () => {
  await server?.stop();
  server = undefined;
  vault?.cleanup();
  vault = undefined;
});

const show = async (v: Vault, ref: string) =>
  JSON.parse((await omni(['show', ref, '--json'], {dir: v.dir, now: NOW})).stdout) as Record<string, unknown>;

describe('filing a clarified item', () => {
  test('a next action keeps its captured tags, gains the answered ones, and logs the decision', async () => {
    const {v, clarify} = await setup();
    await omni(['add', 'Book dentist', '-t', 'calls'], {dir: v.dir, now: NOW});

    const response = await clarify('book-dentist', {from: 'inbox', outcome: {kind: 'file', state: 'next', tags: ['phone']}});
    expect(response.status).toBe(200);

    const task = await show(v, 'book-dentist');
    expect(task['state']).toBe('next');
    expect([...(task['tags'] as string[])].sort()).toEqual(['calls', 'phone']);
    expect((task['log'] as Array<{text: string}>).at(-1)!.text).toBe('Clarified: this is the next action.');
  });

  test('a delegation lands in waiting with who, and the project is stored by its stem', async () => {
    const {v, clarify} = await setup();
    await omni(['project', 'new', 'Renovate the kitchen', '--outcome', 'Cooking in it'], {dir: v.dir, now: NOW});
    await omni(['add', 'Get a quote for tiles'], {dir: v.dir, now: NOW});

    await clarify('get-a-quote-for-tiles', {
      outcome: {kind: 'file', state: 'waiting', tags: [], project: 'Renovate the kitchen', waitingOn: 'Priya'},
    });

    const task = await show(v, 'get-a-quote-for-tiles');
    expect(task).toMatchObject({state: 'waiting', waiting_on: 'Priya', project: 'renovate-the-kitchen', asked: NOW});
  });

  test('a project that does not exist yet is started, and the next step becomes the task', async () => {
    const {v, clarify} = await setup();
    await omni(['add', 'Plan the garden'], {dir: v.dir, now: NOW});

    const response = await clarify('plan-the-garden', {
      from: 'inbox',
      outcome: {kind: 'file', state: 'next', tags: [], project: 'Plan the garden', title: 'Sketch the beds'},
    });
    expect(response.status).toBe(200);

    const task = (await response.json()).task;
    expect(task).toMatchObject({state: 'next', title: 'Sketch the beds', project: 'plan-the-garden'});
    const projects = await omni(['project', 'list', '--json'], {dir: v.dir, now: NOW});
    expect(JSON.parse(projects.stdout)).toEqual([
      expect.objectContaining({stem: 'plan-the-garden', title: 'Plan the garden', outcome: ''}),
    ]);
  });

  test('a confirmed discard deletes it', async () => {
    const {v, clarify} = await setup();
    await omni(['add', 'Old idea'], {dir: v.dir, now: NOW});

    const response = await clarify('old-idea', {from: 'inbox', outcome: {kind: 'discard'}});
    expect(response.status).toBe(200);
    expect(v.list()).toEqual([]);
  });

  test('an item moved elsewhere during the walk is left alone, not deleted', async () => {
    const {v, clarify} = await setup();
    await omni(['add', 'Old idea'], {dir: v.dir, now: NOW});
    // Meanwhile, on another device, someone files it.
    await omni(['mv', 'old-idea', 'someday'], {dir: v.dir, now: NOW});

    const response = await clarify('old-idea', {from: 'inbox', outcome: {kind: 'discard'}});
    expect(response.status).toBe(409);
    expect(v.list()).toEqual(['someday/old-idea.md']);
  });

  test('an outcome the walk could never produce is refused', async () => {
    const {v, clarify} = await setup();
    await omni(['add', 'Something'], {dir: v.dir, now: NOW});

    expect((await clarify('something', {outcome: {kind: 'file', state: 'done', tags: []}})).status).toBe(400);
    expect((await clarify('something', {outcome: {kind: 'shred'}})).status).toBe(400);
    expect(v.list()).toEqual(['inbox/something.md']);
  });
});
