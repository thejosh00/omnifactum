/**
 * The headline guarantee: a human and agents can work at the same time without losing
 * each other's changes.
 *
 * These spawn genuinely concurrent processes against one vault. Nothing is simulated —
 * separate OS processes, the real binary, the real filesystem — because the hole the
 * lock closes is between two system calls, and only real concurrency exercises it.
 *
 * Without the lock, the tag test below loses updates almost every run: each process
 * reads the task, adds its own tag to what it read, and writes the result back, so the
 * last writer silently erases everyone else's tag.
 */
import {afterEach, describe, expect, test} from 'bun:test';
import {readFileSync} from 'node:fs';
import {makeVault, type Vault} from '../helpers/vault.ts';
import {omni} from '../helpers/cli.ts';

const NOW = '2026-09-12T11:03:00Z';
/** Enough writers to lose something if the locking were wrong, few enough to stay quick. */
const WRITERS = 12;

let vault: Vault | undefined;
const openVault = (): Vault => {
  vault = makeVault({layout: false});
  return vault;
};

afterEach(() => {
  vault?.cleanup();
  vault = undefined;
});

interface Ran {
  code: number;
  stdout: string;
  stderr: string;
}

/** Run the real CLI in its own process. */
async function run(dir: string, args: string[]): Promise<Ran> {
  const proc = Bun.spawn(['bun', 'run', 'src/cli.ts', ...args], {
    env: {...process.env, OMNI_DIR: dir, NO_COLOR: '1'},
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return {code, stdout: stdout.trim(), stderr: stderr.trim()};
}

/** Start every command at once, then wait for all of them. */
function together(dir: string, commands: string[][]): Promise<Ran[]> {
  return Promise.all(commands.map(args => run(dir, args)));
}

describe('concurrent writers to the same task', () => {
  test('every tag survives, none is lost', async () => {
    const v = openVault();
    await omni(['init'], {dir: v.dir, now: NOW});
    await omni(['add', 'Contended task', '--next'], {dir: v.dir, now: NOW});

    const results = await together(
      v.dir,
      Array.from({length: WRITERS}, (_, i) => ['tag', 'contended-task', `+writer${i}`]),
    );

    for (const result of results) expect(result.code).toBe(0);

    const written = v.read('next/contended-task.md');
    for (let i = 0; i < WRITERS; i++) {
      expect(written).toContain(`writer${i}`);
    }
  }, 60_000);

  test('the file is still valid markdown afterwards, not a torn mess', async () => {
    const v = openVault();
    await omni(['init'], {dir: v.dir, now: NOW});
    await omni(['add', 'Contended task', '--next'], {dir: v.dir, now: NOW});

    await together(
      v.dir,
      Array.from({length: WRITERS}, (_, i) => ['tag', 'contended-task', `+writer${i}`]),
    );

    const shown = await omni(['show', 'contended-task', '--json'], {dir: v.dir, now: NOW});
    expect(shown.code).toBe(0);
    const task = JSON.parse(shown.stdout) as {tags: string[]; title: string};
    expect(task.title).toBe('Contended task');
    expect(task.tags).toHaveLength(WRITERS);
  }, 60_000);

  test('a note from every writer reaches the log', async () => {
    const v = openVault();
    await omni(['init'], {dir: v.dir, now: NOW});
    await omni(['add', 'Busy task', '--next'], {dir: v.dir, now: NOW});

    const results = await together(
      v.dir,
      Array.from({length: WRITERS}, (_, i) => ['mv', 'busy-task', i % 2 === 0 ? 'next' : 'waiting']),
    );
    for (const result of results) expect(result.code).toBe(0);

    // Each move appends a log line; none of them may be lost.
    const shown = await omni(['show', 'busy-task', '--json'], {dir: v.dir, now: NOW});
    const task = JSON.parse(shown.stdout) as {log: unknown[]};
    expect(task.log).toHaveLength(WRITERS);
  }, 60_000);
});

describe('concurrent completion of the same task', () => {
  test('exactly one succeeds and the rest say so clearly', async () => {
    const v = openVault();
    await omni(['init'], {dir: v.dir, now: NOW});
    await omni(['add', 'Only once', '--next'], {dir: v.dir, now: NOW});

    const results = await together(
      v.dir,
      Array.from({length: WRITERS}, () => ['done', 'only-once', '--note', 'me']),
    );

    const succeeded = results.filter(r => r.code === 0);
    expect(succeeded).toHaveLength(1);

    // Everyone else must fail informatively rather than crash or double-complete.
    for (const failed of results.filter(r => r.code !== 0)) {
      expect(`${failed.stdout}${failed.stderr}`).toMatch(/already done|completed by someone else|no longer there/);
    }

    expect(v.list()).toEqual(['done/2026-09/only-once.md']);
  }, 60_000);
});

describe('concurrent creation', () => {
  test('every task is written, and none overwrites another', async () => {
    const v = openVault();
    await omni(['init'], {dir: v.dir, now: NOW});

    const results = await together(
      v.dir,
      Array.from({length: WRITERS}, (_, i) => ['add', `Task number ${i}`, '--next']),
    );
    for (const result of results) expect(result.code).toBe(0);

    expect(v.list()).toHaveLength(WRITERS);
  }, 60_000);

  test('tasks that would share a filename all survive, with suffixes', async () => {
    const v = openVault();
    await omni(['init'], {dir: v.dir, now: NOW});

    // Same title from every writer, so every one wants the same filename.
    const results = await together(
      v.dir,
      Array.from({length: WRITERS}, () => ['add', 'Identical title', '--next']),
    );
    for (const result of results) expect(result.code).toBe(0);

    expect(v.list()).toHaveLength(WRITERS);

    const listed = await omni(['next', '--json'], {dir: v.dir, now: NOW});
    const tasks = JSON.parse(listed.stdout) as Array<{id: string}>;
    expect(new Set(tasks.map(t => t.id)).size).toBe(WRITERS);
  }, 60_000);
});

describe('a reader running alongside writers', () => {
  test('never sees a half-written file', async () => {
    const v = openVault();
    await omni(['init'], {dir: v.dir, now: NOW});
    await omni(['add', 'Read me', '--next'], {dir: v.dir, now: NOW});

    const work: Array<string[]> = [];
    for (let i = 0; i < WRITERS; i++) {
      work.push(['tag', 'read-me', `+w${i}`]);
      work.push(['next', '--json']);
    }

    const results = await together(v.dir, work);

    for (const result of results) {
      expect(result.code).toBe(0);
      if (result.stdout.startsWith('[')) {
        // A reader. Its output must parse, every time.
        expect(() => JSON.parse(result.stdout)).not.toThrow();
      }
    }
  }, 60_000);
});

describe('a lock left behind by a killed process', () => {
  test('is broken automatically rather than wedging the vault forever', async () => {
    const v = openVault();
    await omni(['init'], {dir: v.dir, now: NOW});
    await omni(['add', 'After the crash', '--next'], {dir: v.dir, now: NOW});

    // A pid that cannot be running, with a timestamp far enough back to be stale.
    v.put(
      '.omni/lock',
      JSON.stringify({pid: 2 ** 30, host: require('node:os').hostname(), at: Date.now() - 600_000}),
    );

    const result = await run(v.dir, ['tag', 'after-the-crash', '+recovered']);
    expect(result.code).toBe(0);
    expect(readFileSync(`${v.dir}/next/after-the-crash.md`, 'utf8')).toContain('recovered');
  }, 30_000);
});
