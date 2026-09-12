/**
 * The watcher is a convenience, never a correctness mechanism, so these tests check
 * that it is quiet when it should be and noisy when it should be — not that anything
 * depends on it. Correctness lives in `write.ts`, which re-checks every file's stamp
 * immediately before writing regardless of what the watcher did.
 */
import {afterEach, describe, expect, test} from 'bun:test';
import {rmSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {watchDataDir, type Watcher} from '../../src/store/watch.ts';
import {makeVault, type Vault} from '../helpers/vault.ts';

let vault: Vault | undefined;
let watcher: Watcher | undefined;

afterEach(() => {
  watcher?.close();
  watcher = undefined;
  vault?.cleanup();
  vault = undefined;
});

const settle = (ms = 250): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

function start(options: Parameters<typeof watchDataDir>[2] = {}): {
  vault: Vault;
  changes: () => number;
} {
  vault = makeVault();
  let changes = 0;
  watcher = watchDataDir(vault.dir, () => {
    changes += 1;
  }, {debounceMs: 30, ...options});
  return {vault: vault, changes: () => changes};
}

describe('noticing changes', () => {
  test('a file appearing is noticed', async () => {
    const {vault: v, changes} = start();
    await settle(50);

    v.put('next/new.md', 'content');
    await settle();

    expect(changes()).toBeGreaterThan(0);
  });

  test('a file being edited is noticed', async () => {
    const {vault: v, changes} = start();
    v.put('next/a.md', 'first');
    await settle();
    const before = changes();

    writeFileSync(join(v.dir, 'next', 'a.md'), 'second, and longer');
    await settle();

    expect(changes()).toBeGreaterThan(before);
  });

  test('a file being moved between states is noticed', async () => {
    const {vault: v, changes} = start();
    v.put('next/a.md', 'content');
    await settle();
    const before = changes();

    v.put('done/2026-09/a.md', 'content');
    rmSync(join(v.dir, 'next', 'a.md'));
    await settle();

    expect(changes()).toBeGreaterThan(before);
  });

  test('a burst of writes collapses into few notifications', async () => {
    const {vault: v, changes} = start({debounceMs: 80});
    await settle(50);

    for (let i = 0; i < 10; i++) v.put(`next/burst-${i}.md`, 'content');
    await settle(300);

    // Ten files, but the screen should not have been asked to redraw ten times.
    expect(changes()).toBeLessThan(5);
    expect(changes()).toBeGreaterThan(0);
  });
});

describe('not reporting our own writes back to us', () => {
  // Without this, the app's own write triggers a reload, which re-renders, which under
  // a held-down key becomes a feedback loop that looks like flicker.
  test('a suppressed path is ignored', async () => {
    const {vault: v, changes} = start();
    await settle(50);
    const before = changes();

    const path = join(v.dir, 'next', 'ours.md');
    watcher!.suppress(path);
    writeFileSync(path, 'written by us');
    await settle();

    expect(changes()).toBe(before);
  });

  test('suppression expires, so a later change to the same file is seen', async () => {
    const {vault: v, changes} = start({suppressMs: 60});
    await settle(50);

    const path = join(v.dir, 'next', 'ours.md');
    watcher!.suppress(path);
    writeFileSync(path, 'ours');
    await settle(150);

    const before = changes();
    writeFileSync(path, 'theirs, and longer');
    await settle();

    expect(changes()).toBeGreaterThan(before);
  });

  test('suppressing one file does not silence another', async () => {
    const {vault: v, changes} = start();
    await settle(50);
    const before = changes();

    watcher!.suppress(join(v.dir, 'next', 'ours.md'));
    v.put('next/theirs.md', 'someone else');
    await settle();

    expect(changes()).toBeGreaterThan(before);
  });
});

describe('being switchable', () => {
  test('disabled means no watching at all', async () => {
    const {vault: v, changes} = start({enabled: false});
    expect(watcher!.active).toBe(false);

    v.put('next/a.md', 'content');
    await settle();

    expect(changes()).toBe(0);
  });

  test('closing stops notifications', async () => {
    const {vault: v, changes} = start();
    await settle(50);
    watcher!.close();
    const before = changes();

    v.put('next/a.md', 'content');
    await settle();

    expect(changes()).toBe(before);
  });

  test('a directory that does not exist does not throw', () => {
    expect(() => {
      const w = watchDataDir('/nonexistent/omni/dir', () => {});
      expect(w.active).toBe(false);
      w.close();
    }).not.toThrow();
  });
});

describe('suppression is scoped to the file being written', () => {
  // The bug this replaced: every known task path was suppressed on each of the
  // interface's own writes, so for 750ms afterwards an agent's change to any *other*
  // task went unnoticed. Editing one task must not blind you to the rest.
  test('suppressing one file leaves every other file visible immediately', async () => {
    const {vault: v, changes} = start({suppressMs: 5_000});
    v.put('next/mine.md', 'the one I am editing');
    v.put('next/theirs.md', 'the one an agent touches');
    await settle();

    watcher!.suppress(join(v.dir, 'next', 'mine.md'));
    const before = changes();

    writeFileSync(join(v.dir, 'next', 'mine.md'), 'my own write, which should be quiet');
    await settle();
    expect(changes()).toBe(before);

    writeFileSync(join(v.dir, 'next', 'theirs.md'), 'an agent wrote this, and I should hear');
    await settle();
    expect(changes()).toBeGreaterThan(before);
  });

  test('a move suppresses both ends, so neither half is reported back', async () => {
    const {vault: v, changes} = start({suppressMs: 5_000});
    v.put('next/moving.md', 'content');
    await settle();
    const before = changes();

    // Both directories already exist. Moving into a *new* month bucket also creates a
    // directory, and that event is not suppressible by filename; it costs one extra
    // rescan, which finds nothing changed and shows nothing, so it is left alone.
    watcher!.suppress(join(v.dir, 'next', 'moving.md'));
    watcher!.suppress(join(v.dir, 'someday', 'moving.md'));

    v.put('someday/moving.md', 'content');
    rmSync(join(v.dir, 'next', 'moving.md'));
    await settle();

    expect(changes()).toBe(before);
  });
});
