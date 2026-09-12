/**
 * The lock itself.
 *
 * The subtle case, and the one that actually bit: a lock file that exists but cannot be
 * read yet. An earlier version created the file and wrote to it afterwards, so a second
 * process could catch it empty, decide it was abandoned, and break a lock that had just
 * been taken. That fails rarely enough to look like it works, which is the worst kind of
 * concurrency bug, so it gets its own tests below.
 */
import {afterEach, describe, expect, test} from 'bun:test';
import {existsSync, readFileSync, readdirSync} from 'node:fs';
import {hostname} from 'node:os';
import {join} from 'node:path';
import {
  LOCK_FILE,
  LockTimeoutError,
  acquireLock,
  holdingLock,
  isStale,
  withLock,
} from '../../src/store/lock.ts';
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

const lockPath = (v: Vault): string => join(v.dir, LOCK_FILE);

describe('holding the lock', () => {
  test('the lock file exists while held and is gone afterwards', () => {
    const v = openVault();
    expect(existsSync(lockPath(v))).toBe(false);

    withLock(v.dir, () => {
      expect(existsSync(lockPath(v))).toBe(true);
    });

    expect(existsSync(lockPath(v))).toBe(false);
  });

  test('it records who holds it, so a stuck lock can be explained', () => {
    const v = openVault();
    withLock(v.dir, () => {
      const info = JSON.parse(readFileSync(lockPath(v), 'utf8')) as Record<string, unknown>;
      expect(info['pid']).toBe(process.pid);
      expect(info['host']).toBe(hostname());
      expect(typeof info['at']).toBe('number');
    });
  });

  test('it is released even when the action throws', () => {
    const v = openVault();
    expect(() =>
      withLock(v.dir, () => {
        throw new Error('boom');
      }),
    ).toThrow('boom');
    expect(existsSync(lockPath(v))).toBe(false);
  });

  test('the value comes back out', () => {
    const v = openVault();
    expect(withLock(v.dir, () => 42)).toBe(42);
  });

  test('it leaves no temporary files behind', () => {
    const v = openVault();
    withLock(v.dir, () => undefined);
    expect(readdirSync(join(v.dir, '.omni'))).toEqual([]);
  });
});

describe('exclusion', () => {
  test('a second acquire while held times out rather than double-entering', () => {
    const v = openVault();
    const held = acquireLock(v.dir);
    try {
      expect(() => acquireLock(v.dir, {timeoutMs: 50, staleMs: 60_000})).toThrow(LockTimeoutError);
    } finally {
      held.release();
    }
  });

  test('after release, the next acquire succeeds immediately', () => {
    const v = openVault();
    acquireLock(v.dir).release();
    const second = acquireLock(v.dir, {timeoutMs: 50});
    second.release();
    expect(existsSync(lockPath(v))).toBe(false);
  });

  test('the timeout names who is holding it', () => {
    const v = openVault();
    const held = acquireLock(v.dir);
    try {
      acquireLock(v.dir, {timeoutMs: 30, staleMs: 60_000});
      throw new Error('should not have acquired');
    } catch (error) {
      expect(error).toBeInstanceOf(LockTimeoutError);
      expect((error as LockTimeoutError).message).toContain(String(process.pid));
    } finally {
      held.release();
    }
  });
});

describe('re-entrancy', () => {
  // A mutation that internally performs another mutation would otherwise deadlock
  // against itself, which is a very confusing way to hang.
  test('a nested withLock does not deadlock', () => {
    const v = openVault();
    const result = withLock(v.dir, () => withLock(v.dir, () => 'inner'), {timeoutMs: 200});
    expect(result).toBe('inner');
  });

  test('the lock is only released when the outermost call finishes', () => {
    const v = openVault();
    withLock(v.dir, () => {
      withLock(v.dir, () => undefined);
      expect(existsSync(lockPath(v))).toBe(true);
    });
    expect(existsSync(lockPath(v))).toBe(false);
  });

  test('holdingLock reports the truth', () => {
    const v = openVault();
    expect(holdingLock()).toBe(false);
    withLock(v.dir, () => {
      expect(holdingLock()).toBe(true);
    });
    expect(holdingLock()).toBe(false);
  });
});

describe('deciding whether a held lock is abandoned', () => {
  const now = 1_000_000;
  const staleMs = 30_000;
  const mine = {pid: process.pid, host: hostname(), at: now - 1_000};

  test('a fresh lock from a living process is not stale', () => {
    expect(isStale(mine, now, staleMs)).toBe(false);
  });

  test('an old lock is stale however alive its owner looks', () => {
    expect(isStale({...mine, at: now - 60_000}, now, staleMs)).toBe(true);
  });

  test('a lock from a dead process on this machine is stale', () => {
    // A pid that cannot be running.
    expect(isStale({pid: 2 ** 30, host: hostname(), at: now}, now, staleMs)).toBe(true);
  });

  test('a lock from another machine is judged only by age', () => {
    const elsewhere = {pid: 2 ** 30, host: 'some-other-host', at: now};
    expect(isStale(elsewhere, now, staleMs)).toBe(false);
    expect(isStale({...elsewhere, at: now - 60_000}, now, staleMs)).toBe(true);
  });

  // The bug that lost updates: a lock file exists but has not been written yet.
  test('an unreadable but freshly created lock is NOT stale', () => {
    expect(isStale(undefined, now, staleMs, 5)).toBe(false);
  });

  test('an unreadable lock is stale once it is genuinely old', () => {
    expect(isStale(undefined, now, staleMs, 60_000)).toBe(true);
  });

  test('an unreadable lock of unknown age is left alone', () => {
    expect(isStale(undefined, now, staleMs, undefined)).toBe(false);
  });
});

describe('recovering from a crash', () => {
  test('a lock from a dead process is broken and taken', () => {
    const v = openVault();
    v.put(
      '.omni/lock',
      JSON.stringify({pid: 2 ** 30, host: hostname(), at: Date.now()}),
    );

    const held = acquireLock(v.dir, {timeoutMs: 200});
    expect(readFileSync(lockPath(v), 'utf8')).toContain(String(process.pid));
    held.release();
  });

  test('a lock older than the stale window is broken and taken', () => {
    const v = openVault();
    v.put(
      '.omni/lock',
      JSON.stringify({pid: process.pid, host: hostname(), at: Date.now() - 120_000}),
    );

    const held = acquireLock(v.dir, {timeoutMs: 200, staleMs: 1_000});
    held.release();
    expect(existsSync(lockPath(v))).toBe(false);
  });

  test('a corrupt lock file is not broken while it is still fresh', () => {
    const v = openVault();
    v.put('.omni/lock', 'not json at all');

    expect(() => acquireLock(v.dir, {timeoutMs: 40, staleMs: 60_000})).toThrow(LockTimeoutError);
  });

  test('a corrupt lock file is broken once it is old enough', () => {
    const v = openVault();
    v.put('.omni/lock', '');

    const held = acquireLock(v.dir, {timeoutMs: 300, staleMs: 1});
    held.release();
  });
});
