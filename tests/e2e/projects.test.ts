/**
 * The project lifecycle, end to end: create, add actions, notice a stall, rename with
 * link rewriting, and complete.
 */
import {afterEach, describe, expect, test} from 'bun:test';
import {renameSync} from 'node:fs';
import {join} from 'node:path';
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
  await omni(['init'], {dir: v.dir, now: NOW});
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
    await omni(['init'], {dir: v.dir, now: NOW});

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

  test('doctor reports the stall and says what to do about it', async () => {
    const v = await withProject();
    const result = await omni(['doctor'], {dir: v.dir, now: NOW});
    expect(result.stdout).toContain('nothing in next or waiting');
    expect(result.stdout).toContain('omni add');
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

    // A task written by an agent that had not seen the rename yet, so it still uses
    // the project's previous stem.
    v.put(
      'next/late-arrival.md',
      '---\nid: 0tq7f2k9aaaa\ntitle: Late arrival\ncreated: 2026-09-12T11:03:00Z\nproject: renovate-the-kitchen\n---\n',
    );

    const listed = await omni(['project', 'show', 'kitchen-refit'], {dir: v.dir, now: NOW});
    expect(listed.stdout).toContain('Late arrival');

    const doctor = await omni(['doctor'], {dir: v.dir, now: NOW});
    expect(doctor.stdout).not.toContain('does not exist');
  });
});

describe('a hand-rename, which is the sharp edge of a readable link', () => {
  test('is caught by the title step of the cascade', async () => {
    const v = await withProject();
    await omni(['add', 'Order the tiles', '-p', 'renovate-the-kitchen', '--next'], {dir: v.dir, now: NOW});

    renameSync(
      join(v.dir, 'projects', 'active', 'renovate-the-kitchen.md'),
      join(v.dir, 'projects', 'active', 'kitchen-2026-FINAL.md'),
    );

    // The stem no longer matches, but the slug of the title still does.
    const shown = await omni(['project', 'show', 'kitchen-2026-FINAL'], {dir: v.dir, now: NOW});
    expect(shown.stdout).toContain('Order the tiles');
  });

  test('a rename that defeats the cascade is reported, not silent', async () => {
    const v = await withProject();
    await omni(['add', 'Order the tiles', '-p', 'renovate-the-kitchen', '--next'], {dir: v.dir, now: NOW});

    // Renaming the file *and* the title leaves nothing to match on.
    v.put(
      'projects/active/unrecognisable.md',
      '---\nid: 0tq7g0a2cdef\ntitle: Something else entirely\noutcome: Done\ncreated: 2026-09-01T09:00:00Z\n---\n',
    );
    renameSync(
      join(v.dir, 'projects', 'active', 'renovate-the-kitchen.md'),
      join(v.dir, 'projects', 'active', 'renovate-the-kitchen.md.bak'),
    );

    const doctor = await omni(['doctor'], {dir: v.dir, now: NOW});
    expect(doctor.stdout).toContain('project "renovate-the-kitchen" does not exist');
    expect(doctor.stdout).toContain('repoint');
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

describe('projects an agent wrote by hand', () => {
  test('a project file with no frontmatter is still a project', async () => {
    const v = openVault();
    await omni(['init'], {dir: v.dir, now: NOW});
    v.put('projects/active/build-the-shed.md', 'A shed, at the bottom of the garden.\n');

    const listed = await omni(['project', 'list'], {dir: v.dir, now: NOW});
    expect(listed.stdout).toContain('build-the-shed');
    expect(listed.stdout).toContain('no outcome');
  });

  test('doctor heals the fields but never invents an outcome', async () => {
    const v = openVault();
    await omni(['init'], {dir: v.dir, now: NOW});
    v.put('projects/active/build-the-shed.md', 'A shed.\n');

    await omni(['doctor', '--fix'], {dir: v.dir, now: NOW});
    const healed = v.read('projects/active/build-the-shed.md');
    expect(healed).toContain('id:');
    expect(healed).toContain('title: Build the shed');
    expect(healed).not.toContain('outcome:');

    const doctor = await omni(['doctor'], {dir: v.dir, now: NOW});
    expect(doctor.stdout).toContain('no outcome statement');
    expect(doctor.stdout).toContain('omni project outcome');
  });

  test('and the outcome can then be supplied', async () => {
    const v = openVault();
    await omni(['init'], {dir: v.dir, now: NOW});
    v.put('projects/active/build-the-shed.md', 'A shed.\n');
    await omni(['doctor', '--fix'], {dir: v.dir, now: NOW});

    const result = await omni(
      ['project', 'outcome', 'build-the-shed', 'Shed built, tools moved in'],
      {dir: v.dir, now: NOW},
    );
    expect(result.code).toBe(0);
    expect(v.read('projects/active/build-the-shed.md')).toContain(
      'outcome: Shed built, tools moved in',
    );
  });
});
