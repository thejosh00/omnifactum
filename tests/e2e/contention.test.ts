/**
 * What a command does when someone else holds the lock.
 *
 * The JSON contract has to survive this. An agent that passes `--json` parses stdout and
 * nothing else, so a command that prints a bare line to stderr and exits 1 because
 * another process happened to be writing is not a busy signal — it is an unparsable
 * answer to a question the agent will now get wrong.
 *
 * The lock is held by writing the file directly with this process's own pid, which is
 * alive and so cannot be judged abandoned. That is exactly the state a second `omni`
 * would leave behind while it works.
 */
import {afterEach, describe, expect, test} from 'bun:test';
import {unlinkSync} from 'node:fs';
import {hostname} from 'node:os';
import {join} from 'node:path';
import {EXIT_BUSY, EXIT_OK} from '../../src/commands/context.ts';
import {LOCK_FILE} from '../../src/store/lock.ts';
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

/** Take the lock and keep it, the way a long write in another process would. */
function holdLock(v: Vault): void {
  v.put(LOCK_FILE, JSON.stringify({pid: process.pid, host: hostname(), at: Date.now()}));
}

/** A vault with one deferred task whose date has arrived, so the sweep has work to do. */
async function vaultWithPromotableTask(): Promise<Vault> {
  const v = openVault();
  await omni(['init'], {dir: v.dir, now: NOW});
  await omni(['add', 'Renew the passport', '--someday', '--defer', '2026-09-01'], {
    dir: v.dir,
    now: NOW,
  });
  return v;
}

describe('a read while someone else is writing', () => {
  test('still answers in JSON, and still exits 0', async () => {
    const v = await vaultWithPromotableTask();
    holdLock(v);

    const result = await omni(['next', '--json'], {dir: v.dir, now: NOW});

    expect(result.code).toBe(EXIT_OK);
    expect(result.stderr).toBe('');
    expect(() => JSON.parse(result.stdout)).not.toThrow();
  });

  test('skips the promotion rather than failing over it', async () => {
    const v = await vaultWithPromotableTask();
    holdLock(v);

    await omni(['next', '--json'], {dir: v.dir, now: NOW});
    expect(v.list()).toEqual(['someday/renew-the-passport.md']);
  });

  test('and the next run, once the lock is free, promotes it after all', async () => {
    const v = await vaultWithPromotableTask();
    holdLock(v);
    await omni(['next', '--json'], {dir: v.dir, now: NOW});

    unlinkSync(join(v.dir, LOCK_FILE));

    const result = await omni(['next', '--json'], {dir: v.dir, now: NOW});
    expect(result.code).toBe(EXIT_OK);
    expect(v.list()).toEqual(['next/renew-the-passport.md']);
  });

  test('a person reading gets their list too, not an error', async () => {
    const v = await vaultWithPromotableTask();
    await omni(['add', 'Call the bank', '--next'], {dir: v.dir, now: NOW});
    holdLock(v);

    const result = await omni(['next'], {dir: v.dir, now: NOW});
    expect(result.code).toBe(EXIT_OK);
    expect(result.stdout).toContain('Call the bank');
  });
});

describe('a write that cannot get the lock', () => {
  test('reports busy as JSON on stdout, with nothing on stderr', async () => {
    const v = openVault();
    await omni(['init'], {dir: v.dir, now: NOW});
    holdLock(v);

    const result = await omni(['add', 'Blocked', '--next', '--json'], {dir: v.dir, now: NOW});

    expect(result.code).toBe(EXIT_BUSY);
    expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout)).toMatchObject({ok: false, code: EXIT_BUSY});
  }, 30_000);

  test('so does one that never went through the write wrapper', async () => {
    // `doctor --fix` takes the lock itself rather than through `runWrite`, so this is
    // the top-level catch being asked to honour the contract, not the wrapper.
    const v = openVault();
    await omni(['init'], {dir: v.dir, now: NOW});
    holdLock(v);

    const result = await omni(['doctor', '--fix', '--json'], {dir: v.dir, now: NOW});

    expect(result.code).toBe(EXIT_BUSY);
    expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout)).toMatchObject({ok: false, code: EXIT_BUSY});
  }, 30_000);

  test('and tells a person plainly, on stderr, with the same code', async () => {
    const v = openVault();
    await omni(['init'], {dir: v.dir, now: NOW});
    holdLock(v);

    const result = await omni(['doctor', '--fix'], {dir: v.dir, now: NOW});

    expect(result.code).toBe(EXIT_BUSY);
    expect(result.stderr).toContain('timed out waiting for the omnifactum lock');
  }, 30_000);
});
