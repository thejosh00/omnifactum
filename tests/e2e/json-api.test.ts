/**
 * The JSON API, which is how an agent reads and writes now.
 *
 * These assert the shape directly, because it is a contract: an agent that parses
 * `.tags` or checks `.ok` must keep working. Two rules are checked everywhere — field
 * names match the frontmatter, and an unset optional field is absent rather than null.
 */
import {afterEach, describe, expect, test} from 'bun:test';
import {makeVault, type Vault} from '../helpers/vault.ts';
import {omni} from '../helpers/cli.ts';

const NOW = '2026-09-12T11:03:00Z';

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
  await omni(['init'], {dir: v.dir, now: NOW});
  await omni(['add', 'Fix printer driver', '-t', 'home,agent', '--next'], {dir: v.dir, now: NOW});
  await omni(['add', 'Draft the memo', '-t', 'work', '--next', '--due', '2026-10-15'], {
    dir: v.dir,
    now: NOW,
  });
  await omni(['add', 'Call the bank'], {dir: v.dir, now: NOW});
  return v;
}

const parse = (text: string): unknown => JSON.parse(text);

describe('reading', () => {
  test('list returns a bare array, which is what jq expects to be handed', async () => {
    const v = await seeded();
    const result = await omni(['next', '--json'], {dir: v.dir, now: NOW});

    expect(result.code).toBe(0);
    const tasks = parse(result.stdout) as unknown[];
    expect(Array.isArray(tasks)).toBe(true);
    expect(tasks).toHaveLength(2);
  });

  test('a task carries every field an agent needs', async () => {
    const v = await seeded();
    const result = await omni(['next', '-t', 'agent', '--json'], {dir: v.dir, now: NOW});
    const [task] = parse(result.stdout) as Array<Record<string, unknown>>;

    expect(task).toMatchObject({
      title: 'Fix printer driver',
      state: 'next',
      tags: ['home', 'agent'],
      created: NOW,
      stem: 'fix-printer-driver',
    });
    expect(typeof task!['id']).toBe('string');
    expect(String(task!['path'])).toContain('/next/fix-printer-driver.md');
  });

  test('field names match the frontmatter, so both views agree', async () => {
    const v = openVault();
    await omni(['init'], {dir: v.dir, now: NOW});
    await omni(['add', 'Chase Acme', '-s', 'waiting', '-w', 'Acme Support'], {dir: v.dir, now: NOW});

    const [task] = parse((await omni(['waiting', '--json'], {dir: v.dir, now: NOW})).stdout) as Array<
      Record<string, unknown>
    >;
    expect(task!['waiting_on']).toBe('Acme Support');
    expect(task).not.toHaveProperty('waitingOn');
  });

  test('an unset optional field is absent, not null', async () => {
    const v = await seeded();
    const [task] = parse((await omni(['inbox', '--json'], {dir: v.dir, now: NOW})).stdout) as Array<
      Record<string, unknown>
    >;

    for (const field of ['project', 'due', 'defer', 'waiting_on', 'asked', 'done']) {
      expect(task).not.toHaveProperty(field);
    }
  });

  test('an empty list is an empty array, not an error or a message', async () => {
    const v = openVault();
    await omni(['init'], {dir: v.dir, now: NOW});
    const result = await omni(['next', '--json'], {dir: v.dir, now: NOW});

    expect(result.code).toBe(0);
    expect(parse(result.stdout)).toEqual([]);
  });

  test('show returns one task object', async () => {
    const v = await seeded();
    const task = parse(
      (await omni(['show', 'fix-printer-driver', '--json'], {dir: v.dir, now: NOW})).stdout,
    ) as Record<string, unknown>;
    expect(task['title']).toBe('Fix printer driver');
  });

  test('the log is structured, so an agent can read what happened', async () => {
    const v = await seeded();
    await omni(['done', 'fix-printer-driver', '--note', 'Installed PPD 4.2'], {dir: v.dir, now: NOW});

    const task = parse(
      (await omni(['show', 'fix-printer-driver', '--json'], {dir: v.dir, now: NOW})).stdout,
    ) as {log: Array<Record<string, string>>};

    expect(task.log).toHaveLength(1);
    expect(task.log[0]).toEqual({at: NOW, actor: 'you', text: 'Installed PPD 4.2'});
  });

  test('tags come back with their counts', async () => {
    const v = await seeded();
    const tags = parse((await omni(['tags', '--json'], {dir: v.dir, now: NOW})).stdout) as Array<
      Record<string, unknown>
    >;
    expect(tags.find(t => t['tag'] === 'home')).toMatchObject({tag: 'home', count: 1});
  });
});

describe('writing', () => {
  test('a mutation returns ok and the resulting task', async () => {
    const v = await seeded();
    const result = await omni(['done', 'fix-printer-driver', '--note', 'Done it', '--json'], {
      dir: v.dir,
      now: NOW,
    });

    expect(result.code).toBe(0);
    const body = parse(result.stdout) as {ok: boolean; task: Record<string, unknown>};
    expect(body.ok).toBe(true);
    expect(body.task['state']).toBe('done');
    expect(body.task['done']).toBe(NOW);
    expect(String(body.task['path'])).toContain('/done/2026-09/');
  });

  test('add returns the task it created', async () => {
    const v = openVault();
    await omni(['init'], {dir: v.dir, now: NOW});

    const body = parse(
      (await omni(['add', 'A new thing', '-t', 'x', '--next', '--json'], {dir: v.dir, now: NOW}))
        .stdout,
    ) as {ok: boolean; task: Record<string, unknown>};

    expect(body.ok).toBe(true);
    expect(body.task['title']).toBe('A new thing');
    expect(body.task['state']).toBe('next');
  });

  test('tag and mv return the updated task', async () => {
    const v = await seeded();

    const tagged = parse(
      (await omni(['tag', 'call-the-bank', '+urgent', '--json'], {dir: v.dir, now: NOW})).stdout,
    ) as {task: {tags: string[]}};
    expect(tagged.task.tags).toEqual(['urgent']);

    const moved = parse(
      (await omni(['mv', 'call-the-bank', 'next', '--json'], {dir: v.dir, now: NOW})).stdout,
    ) as {task: {state: string}};
    expect(moved.task.state).toBe('next');
  });
});

describe('failures parse the same way as successes', () => {
  test('an unknown task is an envelope on stdout, not a message on stderr', async () => {
    const v = await seeded();
    const result = await omni(['done', 'no-such-task', '--json'], {dir: v.dir, now: NOW});

    expect(result.code).toBe(3);
    expect(result.stderr).toBe('');

    const body = parse(result.stdout) as {ok: boolean; error: string; code: number};
    expect(body.ok).toBe(false);
    expect(body.code).toBe(3);
    expect(body.error).toContain('no task matches');
  });

  test('completing something already done reports why', async () => {
    const v = await seeded();
    await omni(['done', 'call-the-bank'], {dir: v.dir, now: NOW});

    const result = await omni(['done', 'call-the-bank', '--json'], {dir: v.dir, now: NOW});
    expect(result.code).not.toBe(0);
    const body = parse(result.stdout) as {ok: boolean; error: string};
    expect(body.ok).toBe(false);
    expect(body.error).toContain('already done');
  });

  test('a usage mistake is JSON too', async () => {
    const v = await seeded();
    const result = await omni(['mv', 'call-the-bank', 'nowhere', '--json'], {dir: v.dir, now: NOW});

    expect(result.code).toBe(2);
    expect((parse(result.stdout) as {ok: boolean}).ok).toBe(false);
  });

  test('deleting still refuses without --yes, and says so in JSON', async () => {
    const v = await seeded();
    const result = await omni(['rm', 'call-the-bank', '--json'], {dir: v.dir, now: NOW});

    expect(result.code).toBe(2);
    const body = parse(result.stdout) as {ok: boolean; error: string; hint: string};
    expect(body.ok).toBe(false);
    expect(body.error).toContain('no undo');
    expect(body.hint).toContain('--yes');
    expect(v.list()).toHaveLength(3);
  });
});

describe('stdout stays clean for a parser', () => {
  test('the tickler sweep never writes to stdout in JSON mode', async () => {
    const v = openVault();
    await omni(['init'], {dir: v.dir, now: NOW});
    await omni(['add', 'Surfaces now', '-s', 'someday', '--defer', '2026-09-01'], {
      dir: v.dir,
      now: NOW,
    });

    const result = await omni(['next', '--json'], {dir: v.dir, now: NOW});
    // Without the guard, "promoted 1 deferred task" would land in the middle of this.
    expect(() => parse(result.stdout)).not.toThrow();
    expect(result.stderr).toBe('');
    expect((parse(result.stdout) as unknown[])).toHaveLength(1);
  });

  test('a filter typo does not corrupt the output', async () => {
    const v = await seeded();
    const result = await omni(['next', '--json', 'due:notadate'], {dir: v.dir, now: NOW});
    expect(() => parse(result.stdout)).not.toThrow();
    expect(result.stderr).toBe('');
  });

  test('doctor reports findings as data', async () => {
    const v = openVault();
    await omni(['init'], {dir: v.dir, now: NOW});
    v.put('inbox/bare-note.md', 'no frontmatter at all\n');

    const result = await omni(['doctor', '--json'], {dir: v.dir, now: NOW});
    const body = parse(result.stdout) as {findings: Array<Record<string, unknown>>};
    expect(body.findings.length).toBeGreaterThan(0);
    expect(body.findings[0]).toHaveProperty('kind');
    expect(body.findings[0]).toHaveProperty('fixable');
  });

  test('projects come back with the stalled flag an agent would act on', async () => {
    const v = openVault();
    await omni(['init'], {dir: v.dir, now: NOW});
    await omni(['project', 'new', 'Kitchen', '--outcome', 'Finished'], {dir: v.dir, now: NOW});

    const [project] = parse(
      (await omni(['project', 'list', '--json'], {dir: v.dir, now: NOW})).stdout,
    ) as Array<Record<string, unknown>>;

    expect(project).toMatchObject({stem: 'kitchen', stalled: true, live_actions: 0});
    expect(project!['outcome']).toBe('Finished');
  });
});

describe('attribution', () => {
  test('--actor is recorded in the log', async () => {
    const v = await seeded();
    const body = parse(
      (
        await omni(
          ['submit', 'call-the-bank', '--note', 'Rang them', '--actor', 'agent:claude-code', '--json'],
          {dir: v.dir, now: NOW},
        )
      ).stdout,
    ) as {task: {log: Array<Record<string, string>>}};

    expect(body.task.log[0]).toEqual({
      at: NOW,
      actor: 'agent:claude-code',
      text: 'Rang them',
    });
  });

  test('OMNI_ACTOR sets it once for a whole agent session', async () => {
    const v = await seeded();
    const previous = process.env['OMNI_ACTOR'];
    process.env['OMNI_ACTOR'] = 'agent:from-env';
    try {
      const body = parse(
        (await omni(['mv', 'call-the-bank', 'waiting', '--json'], {dir: v.dir, now: NOW})).stdout,
      ) as {task: {log: Array<Record<string, string>>}};
      expect(body.task.log[0]?.actor).toBe('agent:from-env');
    } finally {
      if (previous === undefined) delete process.env['OMNI_ACTOR'];
      else process.env['OMNI_ACTOR'] = previous;
    }
  });

  test('--actor beats the environment', async () => {
    const v = await seeded();
    const previous = process.env['OMNI_ACTOR'];
    process.env['OMNI_ACTOR'] = 'agent:from-env';
    try {
      const body = parse(
        (await omni(['mv', 'call-the-bank', 'waiting', '--actor', 'agent:explicit', '--json'], {
          dir: v.dir,
          now: NOW,
        })).stdout,
      ) as {task: {log: Array<Record<string, string>>}};
      expect(body.task.log[0]?.actor).toBe('agent:explicit');
    } finally {
      if (previous === undefined) delete process.env['OMNI_ACTOR'];
      else process.env['OMNI_ACTOR'] = previous;
    }
  });

  test('a person with nothing set is recorded as "you"', async () => {
    const v = await seeded();
    const body = parse(
      (await omni(['mv', 'call-the-bank', 'next', '--json'], {dir: v.dir, now: NOW})).stdout,
    ) as {task: {log: Array<Record<string, string>>}};
    expect(body.task.log[0]?.actor).toBe('you');
  });
});
