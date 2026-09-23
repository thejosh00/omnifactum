/**
 * The human loop, end to end, plus one run of the real binary as a child process.
 *
 * These assert on the resulting files as much as on the output, because the file tree
 * is the product.
 */
import {afterEach, describe, expect, test} from 'bun:test';
import {makeVault, type Vault} from '../helpers/vault.ts';
import {omni, omniSpawn} from '../helpers/cli.ts';

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

describe('capture, organise, act, complete', () => {
  test('the whole loop leaves the right files behind', async () => {
    const v = openVault();
    await omni(['init'], {dir: v.dir, now: NOW});

    // Capture, without thinking about it.
    await omni(['add', 'Fix printer driver'], {dir: v.dir, now: NOW});
    expect(v.list()).toEqual(['inbox/fix-printer-driver.md']);

    // Clarify it into a next action with a context tag.
    await omni(['mv', 'fix-printer-driver', 'next'], {dir: v.dir, now: NOW});
    await omni(['tag', 'fix-printer-driver', '+home', '+errand'], {dir: v.dir, now: NOW});
    expect(v.list()).toEqual(['next/fix-printer-driver.md']);

    // Find it by tag.
    const filtered = await omni(['next', '-t', 'home'], {dir: v.dir, now: NOW});
    expect(filtered.stdout).toContain('Fix printer driver');

    // Complete it with a note.
    const done = await omni(['done', 'fix-printer-driver', '--note', 'Vendor PPD 4.2 did it.'], {
      dir: v.dir,
      now: NOW,
    });
    expect(done.code).toBe(0);

    expect(v.list()).toEqual(['done/2026-09/fix-printer-driver.md']);
    const file = v.read('done/2026-09/fix-printer-driver.md');
    expect(file).toContain('done: 2026-09-12T11:03:00Z');
    expect(file).toContain('tags: [home, errand]');
    expect(file).toContain('**you** — Vendor PPD 4.2 did it.');
  });

  test('a task is readable and pleasant as plain text', async () => {
    const v = openVault();
    await omni(['init'], {dir: v.dir, now: NOW});
    await omni(['add', 'Call the bank', '-t', 'calls'], {dir: v.dir, now: NOW});

    const raw = v.read('inbox/call-the-bank.md');
    // Four frontmatter lines and nothing else. This is the format the contract promises.
    expect(raw).toMatch(
      /^---\nid: [0-9a-hjkmnp-tv-z]{12}\ntitle: Call the bank\ncreated: 2026-09-12T11:03:00Z\ntags: \[calls\]\n---\n$/,
    );
  });
});

describe('filtering, which is how the list gets narrowed', () => {
  async function seeded(): Promise<Vault> {
    const v = openVault();
    await omni(['init'], {dir: v.dir, now: NOW});
    await omni(['add', 'Call the plumber', '-t', 'home,calls', '--next'], {dir: v.dir, now: NOW});
    await omni(['add', 'Call the client', '-t', 'work,calls', '--next'], {dir: v.dir, now: NOW});
    await omni(['add', 'Buy milk', '-t', 'errands', '--next'], {dir: v.dir, now: NOW});
    return v;
  }

  test('two space-separated tags means both', async () => {
    const v = await seeded();
    const out = (await omni(['next', 'calls', 'home'], {dir: v.dir, now: NOW})).stdout;
    expect(out).toContain('plumber');
    expect(out).not.toContain('client');
  });

  test('a comma means either', async () => {
    const v = await seeded();
    const out = (await omni(['next', 'home,work'], {dir: v.dir, now: NOW})).stdout;
    expect(out).toContain('plumber');
    expect(out).toContain('client');
    expect(out).not.toContain('milk');
  });

  test('--not excludes, without fighting the shell', async () => {
    const v = await seeded();
    const out = (await omni(['next', '-t', 'calls', '--not', 'work'], {dir: v.dir, now: NOW})).stdout;
    expect(out).toContain('plumber');
    expect(out).not.toContain('client');
  });

  test('a slash searches the text', async () => {
    const v = await seeded();
    const out = (await omni(['next', '/milk'], {dir: v.dir, now: NOW})).stdout;
    expect(out).toContain('Buy milk');
    expect(out).not.toContain('plumber');
  });

  test('a tag nobody uses matches nothing rather than everything', async () => {
    const v = await seeded();
    expect((await omni(['next', 'nonexistent'], {dir: v.dir, now: NOW})).stdout).toBe(
      'No next actions match.',
    );
  });
});

describe('deferred tasks surface on their date', () => {
  test('a past defer date promotes the task to next, with a log line', async () => {
    const v = openVault();
    await omni(['init'], {dir: v.dir, now: NOW});
    await omni(['add', 'Renew the registration', '-s', 'someday', '--defer', '2026-09-01'], {
      dir: v.dir,
      now: NOW,
    });
    expect(v.list()).toEqual(['someday/renew-the-registration.md']);

    // Any invocation runs the sweep, since there is no daemon.
    await omni(['next'], {dir: v.dir, now: NOW});

    expect(v.list()).toEqual(['next/renew-the-registration.md']);
    const file = v.read('next/renew-the-registration.md');
    expect(file).toContain('**omni** — Deferred until 2026-09-01; promoted to next.');
    expect(file).not.toContain('defer:');
  });

  test('a future defer date leaves the task where it is', async () => {
    const v = openVault();
    await omni(['init'], {dir: v.dir, now: NOW});
    await omni(['add', 'Renew the domain', '-s', 'someday', '--defer', '2027-01-01'], {
      dir: v.dir,
      now: NOW,
    });

    await omni(['next'], {dir: v.dir, now: NOW});
    expect(v.list()).toEqual(['someday/renew-the-domain.md']);
  });

  test('the sweep is idempotent', async () => {
    const v = openVault();
    await omni(['init'], {dir: v.dir, now: NOW});
    await omni(['add', 'Surface me', '-s', 'someday', '--defer', '2026-09-01'], {dir: v.dir, now: NOW});

    await omni(['next'], {dir: v.dir, now: NOW});
    const after = v.read('next/surface-me.md');
    await omni(['next'], {dir: v.dir, now: NOW});
    expect(v.read('next/surface-me.md')).toBe(after);
  });

  test('defer is refused outside someday, so next stays literal', async () => {
    const v = openVault();
    await omni(['init'], {dir: v.dir, now: NOW});
    const result = await omni(['add', 'Wrong', '--next', '--defer', '2027-01-01'], {
      dir: v.dir,
      now: NOW,
    });
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain('someday');
  });
});

describe('deletion is real, and says so', () => {
  test('it refuses without confirmation and suggests someday instead', async () => {
    const v = openVault();
    await omni(['init'], {dir: v.dir, now: NOW});
    await omni(['add', 'Precious'], {dir: v.dir, now: NOW});

    const result = await omni(['rm', 'precious'], {dir: v.dir, now: NOW});
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain('no undo');
    expect(result.stderr).toContain('someday');
    expect(v.list()).toEqual(['inbox/precious.md']);
  });

  test('with --yes it deletes', async () => {
    const v = openVault();
    await omni(['init'], {dir: v.dir, now: NOW});
    await omni(['add', 'Disposable'], {dir: v.dir, now: NOW});

    expect((await omni(['rm', 'disposable', '--yes'], {dir: v.dir, now: NOW})).code).toBe(0);
    expect(v.list()).toEqual([]);
  });

  test('a finished task can be cleared out of the archive', async () => {
    const v = openVault();
    await omni(['init'], {dir: v.dir, now: NOW});
    await omni(['add', 'Shipped it'], {dir: v.dir, now: NOW});
    await omni(['done', 'shipped-it'], {dir: v.dir, now: NOW});
    expect(v.list()).toEqual(['done/2026-09/shipped-it.md']);

    expect((await omni(['rm', 'shipped-it', '--yes'], {dir: v.dir, now: NOW})).code).toBe(0);
    expect(v.list()).toEqual([]);
  });

  test('it does not offer someday for something already finished', async () => {
    const v = openVault();
    await omni(['init'], {dir: v.dir, now: NOW});
    await omni(['add', 'Shipped it'], {dir: v.dir, now: NOW});
    await omni(['done', 'shipped-it'], {dir: v.dir, now: NOW});

    const result = await omni(['rm', 'shipped-it'], {dir: v.dir, now: NOW});
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain('no undo');
    expect(result.stderr).not.toContain('someday');
    expect(v.list()).toEqual(['done/2026-09/shipped-it.md']);
  });
});

describe('referring to a task', () => {
  test('by filename stem, by full id, and by id prefix', async () => {
    const v = openVault();
    await omni(['init'], {dir: v.dir, now: NOW});
    await omni(['add', 'Findable task'], {dir: v.dir, now: NOW});

    const id = /id: ([0-9a-z]{12})/.exec(v.read('inbox/findable-task.md'))![1]!;

    expect((await omni(['show', 'findable-task'], {dir: v.dir, now: NOW})).code).toBe(0);
    expect((await omni(['show', id], {dir: v.dir, now: NOW})).code).toBe(0);
    expect((await omni(['show', id.slice(0, 9)], {dir: v.dir, now: NOW})).code).toBe(0);
  });

  test('an unknown reference fails with a clear message and its own exit code', async () => {
    const v = openVault();
    await omni(['init'], {dir: v.dir, now: NOW});

    const result = await omni(['done', 'nothing-like-this'], {dir: v.dir, now: NOW});
    expect(result.code).toBe(3);
    expect(result.stderr).toContain('no task matches');
  });
});

describe('the real binary, run as a user would run it', () => {
  test('init, add, and list work in a child process', async () => {
    const v = openVault();

    const init = await omniSpawn(['init'], {dir: v.dir});
    expect(init.code).toBe(0);
    expect(init.stdout).toContain('ready in');

    expect((await omniSpawn(['add', 'Built and installed', '-t', 'shipping'], {dir: v.dir})).code).toBe(0);

    const listed = await omniSpawn(['inbox'], {dir: v.dir});
    expect(listed.code).toBe(0);
    expect(listed.stdout).toContain('Built and installed');

    expect(v.list()).toEqual(['inbox/built-and-installed.md']);
  });

  test('--version and --help do not need a data directory', async () => {
    const v = openVault();
    expect((await omniSpawn(['--version'], {dir: v.dir})).stdout).toMatch(/^\d+\.\d+\.\d+$/);
    const help = (await omniSpawn(['--help'], {dir: v.dir})).stdout;
    expect(help).toContain('capture a task');
    expect(help).toContain('print the contract agents read');
  });

  test('an unknown command exits with the usage code', async () => {
    const v = openVault();
    const result = await omniSpawn(['frobnicate'], {dir: v.dir});
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('is not a command');
  });
});
