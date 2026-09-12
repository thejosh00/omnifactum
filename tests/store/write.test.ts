import {afterEach, describe, expect, test} from 'bun:test';
import {existsSync, readFileSync, readdirSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {
  StaleWriteError,
  TEMP_PREFIX,
  atomicMove,
  atomicWrite,
  backupConflict,
  deleteFile,
  freePath,
  stampOf,
  sweepTempFiles,
} from '../../src/store/write.ts';
import {makeVault, type Vault} from '../helpers/vault.ts';

let vault: Vault | undefined;
const openVault = (): Vault => {
  vault = makeVault();
  return vault;
};

afterEach(() => {
  vault?.cleanup();
  vault = undefined;
});

describe('atomicWrite', () => {
  test('writes the content', () => {
    const v = openVault();
    const path = join(v.dir, 'next', 'a.md');
    atomicWrite(path, 'hello', {expect: undefined});
    expect(readFileSync(path, 'utf8')).toBe('hello');
  });

  test('creates missing directories', () => {
    const v = openVault();
    const path = join(v.dir, 'done', '2026-09', 'a.md');
    atomicWrite(path, 'hello', {expect: undefined});
    expect(existsSync(path)).toBe(true);
  });

  test('leaves no temp file behind', () => {
    const v = openVault();
    atomicWrite(join(v.dir, 'next', 'a.md'), 'hello', {expect: undefined});
    const leftovers = readdirSync(join(v.dir, 'next')).filter(n => n.startsWith(TEMP_PREFIX));
    expect(leftovers).toEqual([]);
  });

  test('returns a stamp that matches the file just written', () => {
    const v = openVault();
    const path = join(v.dir, 'next', 'a.md');
    const stamp = atomicWrite(path, 'hello', {expect: undefined});
    expect(stamp).toEqual(stampOf(path)!);
  });

  test('overwrites when the file still matches what was read', () => {
    const v = openVault();
    const path = v.put('next/a.md', 'first');
    const before = stampOf(path);
    atomicWrite(path, 'second', {expect: before});
    expect(readFileSync(path, 'utf8')).toBe('second');
  });
});

describe('the staleness check, which is what stands in for a lock', () => {
  test('refuses to clobber a file that changed since it was read', () => {
    const v = openVault();
    const path = v.put('next/a.md', 'original');
    const stamp = stampOf(path);

    // Something else — an agent, another terminal — rewrites the file.
    writeFileSync(path, 'written by someone else, and longer');

    expect(() => atomicWrite(path, 'mine', {expect: stamp})).toThrow(StaleWriteError);
    expect(readFileSync(path, 'utf8')).toBe('written by someone else, and longer');
  });

  test('refuses to create a file that appeared underneath us', () => {
    const v = openVault();
    v.put('next/a.md', 'someone got here first');
    expect(() => atomicWrite(join(v.dir, 'next', 'a.md'), 'mine', {expect: undefined})).toThrow(
      StaleWriteError,
    );
  });

  test('refuses to write a file that was deleted since it was read', () => {
    const v = openVault();
    const path = v.put('next/a.md', 'original');
    const stamp = stampOf(path);
    deleteFile(path);
    expect(() => atomicWrite(path, 'mine', {expect: stamp})).toThrow(StaleWriteError);
  });

  test('force skips the check, for files the app alone owns', () => {
    const v = openVault();
    const path = v.put('AGENTS.md', 'old contract');
    atomicWrite(path, 'new contract', {force: true});
    expect(readFileSync(path, 'utf8')).toBe('new contract');
  });
});

describe('atomicMove', () => {
  test('moves a file between states', () => {
    const v = openVault();
    const from = v.put('next/a.md', 'content');
    const to = join(v.dir, 'done', '2026-09', 'a.md');
    expect(atomicMove(from, to)).toBe(to);
    expect(existsSync(from)).toBe(false);
    expect(readFileSync(to, 'utf8')).toBe('content');
  });

  test('never overwrites an existing file at the destination', () => {
    const v = openVault();
    const from = v.put('next/a.md', 'mine');
    v.put('done/2026-09/a.md', 'theirs');

    const landed = atomicMove(from, join(v.dir, 'done', '2026-09', 'a.md'));
    expect(landed.endsWith('a-2.md')).toBe(true);
    expect(v.read('done/2026-09/a.md')).toBe('theirs');
    expect(readFileSync(landed, 'utf8')).toBe('mine');
  });

  test('the same id never ends up in two places', () => {
    const v = openVault();
    const from = v.put('next/a.md', 'content');
    atomicMove(from, join(v.dir, 'done', '2026-09', 'a.md'));
    expect(v.list()).toEqual(['done/2026-09/a.md']);
  });
});

describe('freePath', () => {
  test('returns the path when it is free', () => {
    const v = openVault();
    const path = join(v.dir, 'next', 'a.md');
    expect(freePath(path)).toBe(path);
  });

  test('suffixes before the extension, not after', () => {
    const v = openVault();
    v.put('next/a.md', 'x');
    expect(freePath(join(v.dir, 'next', 'a.md'))).toBe(join(v.dir, 'next', 'a-2.md'));
  });

  test('keeps counting past the first collision', () => {
    const v = openVault();
    v.put('next/a.md', 'x');
    v.put('next/a-2.md', 'x');
    expect(freePath(join(v.dir, 'next', 'a.md'))).toBe(join(v.dir, 'next', 'a-3.md'));
  });
});

describe('completing a task writes content before it moves', () => {
  // A crash between the two steps must leave one valid file in the old directory,
  // not the same task in two directories.
  test('a crash after the content write leaves one findable, valid file', () => {
    const v = openVault();
    const path = v.put('next/a.md', 'original');

    const stamp = stampOf(path);
    atomicWrite(path, 'original\n\n## Log\n\n- 2026-09-12T11:03:00Z **you** — done\n', {
      expect: stamp,
    });
    // ...and then the process dies before the move.

    expect(v.list()).toEqual(['next/a.md']);
    expect(v.read('next/a.md')).toContain('done');
  });
});

describe('conflict backups', () => {
  test('preserve content the app would otherwise have destroyed', () => {
    const v = openVault();
    const path = backupConflict(v.dir, 'a.md', 'the losing version', '2026-09-12T11:03:00Z');
    expect(readFileSync(path, 'utf8')).toBe('the losing version');
    expect(path).toContain(join('.omni', 'conflicts'));
  });

  test('live in a hidden directory, outside every state folder', () => {
    const v = openVault();
    backupConflict(v.dir, 'a.md', 'losing', '2026-09-12T11:03:00Z');
    // The scanner only ever looks inside the state directories and skips dotfiles,
    // so a backup here can never be mistaken for a task. `scan.test.ts` proves that
    // end of it; this asserts the placement the guarantee rests on.
    expect(v.list()).toEqual(['.omni/conflicts/2026-09-12T11-03-00Z-a.md']);
  });

  test('two backups of the same file do not overwrite each other', () => {
    const v = openVault();
    const first = backupConflict(v.dir, 'a.md', 'one', '2026-09-12T11:03:00Z');
    const second = backupConflict(v.dir, 'a.md', 'two', '2026-09-12T11:03:00Z');
    expect(first).not.toBe(second);
    expect(readFileSync(first, 'utf8')).toBe('one');
  });
});

describe('sweeping temp files left by a crash', () => {
  test('removes an old temp file', () => {
    const v = openVault();
    const dir = join(v.dir, 'next');
    const temp = join(dir, `${TEMP_PREFIX}stale`);
    writeFileSync(temp, 'half a write');

    const swept = sweepTempFiles(dir, 60_000, Date.now() + 120_000);
    expect(swept).toEqual([temp]);
    expect(existsSync(temp)).toBe(false);
  });

  test('leaves a fresh one alone, since another process may be mid-write', () => {
    const v = openVault();
    const dir = join(v.dir, 'next');
    writeFileSync(join(dir, `${TEMP_PREFIX}fresh`), 'in progress');
    expect(sweepTempFiles(dir, 60_000, Date.now())).toEqual([]);
  });

  test('never touches a real task file', () => {
    const v = openVault();
    v.put('next/a.md', 'a task');
    sweepTempFiles(join(v.dir, 'next'), 0, Date.now() + 1);
    expect(v.exists('next/a.md')).toBe(true);
  });
});
