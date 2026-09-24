/**
 * The review queue: an agent finishes work, a person decides whether it is done.
 *
 * The point of the state is that finished agent work lands somewhere a person will
 * actually see it. Completing it outright would file it under `done/YYYY-MM/`, outside
 * every default view, so noticing it would depend on remembering to go and look.
 */
import {afterEach, describe, expect, test} from 'bun:test';
import {makeVault, type Vault} from '../helpers/vault.ts';
import {omni, serveFor} from '../helpers/cli.ts';

const NOW = '2026-09-12T11:03:00Z';
const AGENT = 'agent:claude-code';

let vault: Vault | undefined;
const openVault = (): Vault => {
  vault = makeVault({layout: false});
  return vault;
};

afterEach(() => {
  vault?.cleanup();
  vault = undefined;
});

async function seeded(): Promise<Vault> {
  const v = openVault();
  await omni(['add', 'Fix printer driver', '-t', 'agent', '--next'], {dir: v.dir, now: NOW});
  return v;
}

const asAgent = (v: Vault, args: string[]) =>
  omni([...args, '--actor', AGENT], {dir: v.dir, now: NOW});

describe('an agent hands work back rather than finishing it', () => {
  test('submit moves the task to review with the note attached', async () => {
    const v = await seeded();

    const result = await asAgent(v, [
      'submit',
      'fix-printer-driver',
      '--note',
      'Installed vendor PPD 4.2, test page prints clean.',
    ]);
    expect(result.code).toBe(0);

    expect(v.list()).toEqual(['review/fix-printer-driver.md']);
    const file = v.read('review/fix-printer-driver.md');
    expect(file).toContain('**agent:claude-code** — Installed vendor PPD 4.2');
    // Not done: acceptance is a person's call, and only that sets the date.
    expect(file).not.toContain('done:');
  });

  test('it leaves the next list, so it is not offered as work again', async () => {
    const v = await seeded();
    await asAgent(v, ['submit', 'fix-printer-driver', '--note', 'done it']);

    expect((await omni(['next', '--json'], {dir: v.dir, now: NOW})).stdout).toBe('[]');
    expect((await asAgent(v, ['next', '--tag', 'agent', '--json'])).stdout).toBe('[]');
  });

  test('it shows up where a person will see it', async () => {
    const v = await seeded();
    await asAgent(v, ['submit', 'fix-printer-driver', '--note', 'Installed PPD 4.2.']);

    const listed = await omni(['review'], {dir: v.dir, now: NOW});
    expect(listed.code).toBe(0);
    expect(listed.stdout).toContain('Fix printer driver');
  });

  test('submitting without a note is refused, since the note is the whole point', async () => {
    const v = await seeded();

    const result = await asAgent(v, ['submit', 'fix-printer-driver']);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('what did you do?');
    expect(v.list()).toEqual(['next/fix-printer-driver.md']);
  });

  test('submitting the same work twice is refused', async () => {
    const v = await seeded();
    await asAgent(v, ['submit', 'fix-printer-driver', '--note', 'first']);

    const again = await asAgent(v, ['submit', 'fix-printer-driver', '--note', 'second']);
    expect(again.code).not.toBe(0);
    expect(again.stderr).toContain('already waiting to be reviewed');
  });
});

describe('an agent may not accept its own work', () => {
  test('done is refused for an agent, and points at submit', async () => {
    const v = await seeded();

    const result = await asAgent(v, ['done', 'fix-printer-driver', '--note', 'all finished']);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('omni submit');
    expect(v.list()).toEqual(['next/fix-printer-driver.md']);
  });

  test('the refusal is JSON when an agent asked for JSON', async () => {
    const v = await seeded();

    const result = await asAgent(v, ['done', 'fix-printer-driver', '--json']);
    expect(result.stderr).toBe('');
    const body = JSON.parse(result.stdout) as {ok: boolean; error: string; hint: string};
    expect(body.ok).toBe(false);
    expect(body.hint).toContain('omni submit');
  });

  test('--force overrides it, for an agent that has been told to', async () => {
    const v = await seeded();

    const result = await asAgent(v, ['done', 'fix-printer-driver', '--note', 'told to', '--force']);
    expect(result.code).toBe(0);
    expect(v.list()).toEqual(['done/2026-09/fix-printer-driver.md']);
  });

  test('a person is never stopped', async () => {
    const v = await seeded();

    expect((await omni(['done', 'fix-printer-driver'], {dir: v.dir, now: NOW})).code).toBe(0);
    expect(v.list()).toEqual(['done/2026-09/fix-printer-driver.md']);
  });
});

describe('a person reviews the work', () => {
  async function submitted(): Promise<Vault> {
    const v = await seeded();
    await asAgent(v, ['submit', 'fix-printer-driver', '--note', 'Installed vendor PPD 4.2.']);
    return v;
  }

  test('accepting it is an ordinary done', async () => {
    const v = await submitted();

    const result = await omni(['done', 'fix-printer-driver', '--note', 'Checked, prints fine.'], {
      dir: v.dir,
      now: NOW,
    });
    expect(result.code).toBe(0);

    expect(v.list()).toEqual(['done/2026-09/fix-printer-driver.md']);
    const file = v.read('done/2026-09/fix-printer-driver.md');
    // Both halves of the story survive: what the agent did, and that you accepted it.
    expect(file).toContain('**agent:claude-code** — Installed vendor PPD 4.2.');
    expect(file).toContain('**you** — Checked, prints fine.');
    expect(file).toContain('done: 2026-09-12T11:03:00Z');
  });

  test('rejecting it sends it back with a reason the agent can read', async () => {
    const v = await submitted();

    const result = await omni(
      ['mv', 'fix-printer-driver', 'next', '--note', 'Still jams on duplex.'],
      {dir: v.dir, now: NOW},
    );
    expect(result.code).toBe(0);

    expect(v.list()).toEqual(['next/fix-printer-driver.md']);
    const file = v.read('next/fix-printer-driver.md');
    expect(file).toContain('**you** — Still jams on duplex.');
    expect(file).toContain('**agent:claude-code** — Installed vendor PPD 4.2.');
  });

  test('a rejected task is offered to agents again', async () => {
    const v = await submitted();
    await omni(['mv', 'fix-printer-driver', 'next', '--note', 'not quite'], {dir: v.dir, now: NOW});

    const work = JSON.parse(
      (await omni(['next', '--tag', 'agent', '--json'], {dir: v.dir, now: NOW})).stdout,
    ) as unknown[];
    expect(work).toHaveLength(1);
  });

  test('review is visible in the JSON API like any other state', async () => {
    const v = await submitted();

    const tasks = JSON.parse(
      (await omni(['list', 'state:review', '--json'], {dir: v.dir, now: NOW})).stdout,
    ) as Array<{state: string}>;
    expect(tasks).toHaveLength(1);
    expect(tasks[0]?.state).toBe('review');
  });
});

describe('review and the rest of the system', () => {
  test('a project whose only action is in review is not stalled', async () => {
    const v = openVault();
    await omni(['project', 'new', 'Kitchen', '--outcome', 'Finished'], {dir: v.dir, now: NOW});
    await omni(['add', 'Order tiles', '-p', 'kitchen', '--next'], {dir: v.dir, now: NOW});

    await asAgent(v, ['submit', 'order-tiles', '--note', 'Ordered, arriving Tuesday.']);

    // Work is in flight and waiting on you, which is progress rather than a stall.
    const stalled = await omni(['project', 'list', '--stalled'], {dir: v.dir, now: NOW});
    expect(stalled.stdout).toBe('Nothing is stalled.');
  });

  test('review is a flat queue, not bucketed by month like done', async () => {
    const v = await seeded();
    await asAgent(v, ['submit', 'fix-printer-driver', '--note', 'done']);
    expect(v.list()).toEqual(['review/fix-printer-driver.md']);
  });

});

describe('the weekly review over HTTP', () => {
  test('it says what needs attention, points at the task, and records a pass', async () => {
    const v = openVault();
    const server = serveFor(v.dir, NOW);
    try {
      const token = server.token('you');
      const get = (path: string, method = 'GET') =>
        fetch(`${server.url}${path}`, {method, headers: {authorization: `Bearer ${token}`}}).then(
          r => r.json() as Promise<Record<string, any>>,
        );
      await omni(['add', 'File taxes', '--next', '--due', '2026-01-01', '-t', 'admin'], {dir: v.dir, now: NOW});
      await omni(['project', 'new', 'Kitchen', '--outcome', 'Cooking in it'], {dir: v.dir, now: NOW});
      const taxes = JSON.parse((await omni(['show', 'file-taxes', '--json'], {dir: v.dir, now: NOW})).stdout).id;

      const before = await get('/api/weekly');
      expect(before['days_since_last_review']).toBeUndefined();
      const next = before['steps'].find((s: any) => s.step === 'next');
      expect(next.flags).toEqual(['"File taxes" is past its due date']);
      expect(next.flag_tasks).toEqual([taxes]);
      expect(next.list).toBe('next');

      const recorded = await get('/api/weekly/record', 'POST');
      expect(recorded).toMatchObject({ok: true, projects_stamped: 1});

      const after = await get('/api/weekly');
      expect(after['days_since_last_review']).toBe(0);
      const project = JSON.parse((await omni(['project', 'show', 'kitchen', '--json'], {dir: v.dir, now: NOW})).stdout);
      expect(project.project.reviewed).toBeDefined();
    } finally {
      await server.stop();
    }
  });
});
