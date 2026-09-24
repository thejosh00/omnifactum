/**
 * The project lifecycle, end to end: create, add actions, notice a stall, rename with
 * link rewriting, and complete.
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

async function withProject(): Promise<Vault> {
  const v = openVault();
  await omni(
    ['project', 'new', 'Renovate the kitchen', '--outcome', 'New kitchen finished and paid for'],
    {dir: v.dir, now: NOW},
  );
  return v;
}

describe('creating a project', () => {
  test('writes a readable file under projects/active', async () => {
    const v = await withProject();
    expect(v.list()).toEqual(['projects/active/renovate-the-kitchen.md']);
    expect(v.read('projects/active/renovate-the-kitchen.md')).toBe(
      '---\nid: ' +
        /id: (\S+)/.exec(v.read('projects/active/renovate-the-kitchen.md'))![1]! +
        '\ntitle: Renovate the kitchen\noutcome: New kitchen finished and paid for\ncreated: 2026-09-12T11:03:00Z\n---\n',
    );
  });

  test('refuses without an outcome, because that is the point of a project', async () => {
    const v = openVault();

    const result = await omni(['project', 'new', 'Vague ambition'], {dir: v.dir, now: NOW});
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain('what does done look like');
    expect(v.list()).toEqual([]);
  });

  test('tells you how to give it a next action', async () => {
    const v = await withProject();
    const result = await omni(['project', 'new', 'Second', '--outcome', 'Done'], {
      dir: v.dir,
      now: NOW,
    });
    expect(result.stdout).toContain('omni add');
    expect(result.stdout).toContain('-p second');
  });
});

describe('attaching actions', () => {
  test('a task records the project by its readable stem', async () => {
    const v = await withProject();
    await omni(['add', 'Order the tiles', '-p', 'renovate-the-kitchen', '--next'], {
      dir: v.dir,
      now: NOW,
    });
    expect(v.read('next/order-the-tiles.md')).toContain('project: renovate-the-kitchen');
  });

  test('-p accepts an id or a title and still stores the stem', async () => {
    const v = await withProject();
    const id = /id: (\S+)/.exec(v.read('projects/active/renovate-the-kitchen.md'))![1]!;

    await omni(['add', 'By id', '-p', id, '--next'], {dir: v.dir, now: NOW});
    expect(v.read('next/by-id.md')).toContain('project: renovate-the-kitchen');

    await omni(['add', 'By title', '-p', 'Renovate the Kitchen', '--next'], {dir: v.dir, now: NOW});
    expect(v.read('next/by-title.md')).toContain('project: renovate-the-kitchen');
  });

  test('a project that does not exist yet is kept and reported, not dropped', async () => {
    const v = await withProject();
    const result = await omni(['add', 'Too early', '-p', 'bathroom', '--next'], {
      dir: v.dir,
      now: NOW,
    });
    expect(result.stderr).toContain('will dangle');
    expect(v.read('next/too-early.md')).toContain('project: bathroom');
  });

  test('filtering by project works', async () => {
    const v = await withProject();
    await omni(['add', 'Order the tiles', '-p', 'renovate-the-kitchen', '--next'], {dir: v.dir, now: NOW});
    await omni(['add', 'Unrelated', '--next'], {dir: v.dir, now: NOW});

    const out = (await omni(['next', 'project:renovate-the-kitchen'], {dir: v.dir, now: NOW})).stdout;
    expect(out).toContain('Order the tiles');
    expect(out).not.toContain('Unrelated');
  });
});

describe('the stalled check, which is what a tag could never do', () => {
  test('a project with no next action is reported as stalled', async () => {
    const v = await withProject();
    const out = (await omni(['project', 'list', '--stalled'], {dir: v.dir, now: NOW})).stdout;
    expect(out).toContain('renovate-the-kitchen');
    expect(out).toContain('STALLED');
  });

  test('giving it a next action clears the stall', async () => {
    const v = await withProject();
    await omni(['add', 'Order the tiles', '-p', 'renovate-the-kitchen', '--next'], {dir: v.dir, now: NOW});
    expect((await omni(['project', 'list', '--stalled'], {dir: v.dir, now: NOW})).stdout).toBe(
      'Nothing is stalled.',
    );
  });

  test('a task in the inbox does not count, because it has not been thought about', async () => {
    const v = await withProject();
    await omni(['add', 'Vaguely kitchen-related', '-p', 'renovate-the-kitchen'], {dir: v.dir, now: NOW});
    expect((await omni(['project', 'list', '--stalled'], {dir: v.dir, now: NOW})).stdout).toContain(
      'STALLED',
    );
  });

  test('completing the only action makes it stalled again', async () => {
    const v = await withProject();
    await omni(['add', 'Order the tiles', '-p', 'renovate-the-kitchen', '--next'], {dir: v.dir, now: NOW});
    await omni(['done', 'order-the-tiles'], {dir: v.dir, now: NOW});

    expect((await omni(['project', 'list', '--stalled'], {dir: v.dir, now: NOW})).stdout).toContain(
      'STALLED',
    );
  });

});

describe('renaming rewrites the links', () => {
  test('member tasks are repointed and the file is renamed', async () => {
    const v = await withProject();
    await omni(['add', 'Order the tiles', '-p', 'renovate-the-kitchen', '--next'], {dir: v.dir, now: NOW});
    await omni(['add', 'Book the fitter', '-p', 'renovate-the-kitchen', '--next'], {dir: v.dir, now: NOW});

    const result = await omni(['project', 'rename', 'renovate-the-kitchen', 'Kitchen refit'], {
      dir: v.dir,
      now: NOW,
    });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('repointed 2 tasks');

    expect(v.exists('projects/active/kitchen-refit.md')).toBe(true);
    expect(v.read('next/order-the-tiles.md')).toContain('project: kitchen-refit');
    expect(v.read('next/book-the-fitter.md')).toContain('project: kitchen-refit');
  });

  test('the old name is kept as an alias', async () => {
    const v = await withProject();
    await omni(['project', 'rename', 'renovate-the-kitchen', 'Kitchen refit'], {dir: v.dir, now: NOW});
    expect(v.read('projects/active/kitchen-refit.md')).toContain('aliases: [renovate-the-kitchen]');
  });

  test('so a task still using the old name resolves anyway', async () => {
    const v = await withProject();
    await omni(['project', 'rename', 'renovate-the-kitchen', 'Kitchen refit'], {dir: v.dir, now: NOW});

    // An agent that had not seen the rename yet, so it still uses the previous stem.
    const added = await omni(['add', 'Late arrival', '-p', 'renovate-the-kitchen', '--next'], {
      dir: v.dir,
      now: NOW,
    });
    expect(added.stderr).toBe('');

    const listed = await omni(['project', 'show', 'kitchen-refit'], {dir: v.dir, now: NOW});
    expect(listed.stdout).toContain('Late arrival');

    const orphans = await omni(['project', 'list', '--json'], {dir: v.dir, now: NOW});
    expect(orphans.stdout).not.toContain('does not exist');
  });
});

describe('completing a project', () => {
  test('it refuses while actions are still open, and says which', async () => {
    const v = await withProject();
    await omni(['add', 'Order the tiles', '-p', 'renovate-the-kitchen', '--next'], {dir: v.dir, now: NOW});

    const result = await omni(['project', 'done', 'renovate-the-kitchen'], {dir: v.dir, now: NOW});
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain('Order the tiles');
    expect(result.stderr).toContain('--yes');
  });

  test('--yes overrides that', async () => {
    const v = await withProject();
    await omni(['add', 'Order the tiles', '-p', 'renovate-the-kitchen', '--next'], {dir: v.dir, now: NOW});

    expect(
      (await omni(['project', 'done', 'renovate-the-kitchen', '--yes'], {dir: v.dir, now: NOW})).code,
    ).toBe(0);
    expect(v.exists('projects/done/2026-09/renovate-the-kitchen.md')).toBe(true);
  });

  test('with everything finished it files the project under its UTC month', async () => {
    const v = await withProject();
    await omni(['add', 'Order the tiles', '-p', 'renovate-the-kitchen', '--next'], {dir: v.dir, now: NOW});
    await omni(['done', 'order-the-tiles'], {dir: v.dir, now: NOW});

    const result = await omni(['project', 'done', 'renovate-the-kitchen', '--note', 'Signed off.'], {
      dir: v.dir,
      now: NOW,
    });
    expect(result.code).toBe(0);

    const file = v.read('projects/done/2026-09/renovate-the-kitchen.md');
    expect(file).toContain('done: 2026-09-12T11:03:00Z');
    expect(file).toContain('**you** — Signed off.');
  });

  test('a completed project drops out of the default list', async () => {
    const v = await withProject();
    await omni(['project', 'done', 'renovate-the-kitchen', '--yes'], {dir: v.dir, now: NOW});

    expect((await omni(['project', 'list'], {dir: v.dir, now: NOW})).stdout).toBe('No projects yet.');
    expect((await omni(['project', 'list', '--all'], {dir: v.dir, now: NOW})).stdout).toContain(
      'renovate-the-kitchen',
    );
  });
});

