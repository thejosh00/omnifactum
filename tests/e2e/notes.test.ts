/**
 * `omni note` — recording what happened without moving anything.
 *
 * Progress is not always a state change. An agent halfway through a long job, or a
 * person noting that the supplier finally called back, has something worth writing down
 * and no move to make. `planNote` existed in core from the start and nothing exposed it,
 * so the only way to leave a record was to move the task somewhere it did not belong.
 */
import {afterEach, describe, expect, test} from 'bun:test';
import {EXIT_NOT_FOUND, EXIT_OK, EXIT_USAGE} from '../../src/commands/context.ts';
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
  await omni(['add', 'Fix printer driver', '-t', 'home,agent', '--next'], {dir: v.dir, now: NOW});
  return v;
}

describe('recording what happened', () => {
  test('appends a log line and leaves the task exactly where it was', async () => {
    const v = await seeded();

    const result = await omni(['note', 'fix-printer-driver', 'Vendor support says PPD 4.2.'], {
      dir: v.dir,
      now: NOW,
    });

    expect(result.code).toBe(EXIT_OK);
    expect(v.list()).toEqual(['next/fix-printer-driver.md']);
    expect(v.read('next/fix-printer-driver.md')).toContain('**you** — Vendor support says PPD 4.2.');
  });

  test('the state, tags and title are untouched', async () => {
    const v = await seeded();
    const before = JSON.parse(
      (await omni(['show', 'fix-printer-driver', '--json'], {dir: v.dir, now: NOW})).stdout,
    ) as Record<string, unknown>;

    await omni(['note', 'fix-printer-driver', 'Still looking.'], {dir: v.dir, now: NOW});

    const after = JSON.parse(
      (await omni(['show', 'fix-printer-driver', '--json'], {dir: v.dir, now: NOW})).stdout,
    ) as Record<string, unknown>;

    expect({...after, log: [], version: 0}).toEqual({...before, log: [], version: 0});
    expect((after['log'] as unknown[]).length).toBe((before['log'] as unknown[]).length + 1);
  });

  test('an agent is recorded as the author', async () => {
    const v = await seeded();

    const result = await omni(
      ['note', 'fix-printer-driver', 'Downloaded the driver.', '--actor', 'agent:claude-code', '--json'],
      {dir: v.dir, now: NOW},
    );

    expect(result.code).toBe(EXIT_OK);
    const {task} = JSON.parse(result.stdout) as {
      task: {log: Array<{at: string; actor: string; text: string}>};
    };
    expect(task.log.at(-1)).toEqual({
      at: NOW,
      actor: 'agent:claude-code',
      text: 'Downloaded the driver.',
    });
  });

  test('several notes accumulate in order rather than replacing each other', async () => {
    const v = await seeded();
    await omni(['note', 'fix-printer-driver', 'First.'], {dir: v.dir, now: NOW});
    await omni(['note', 'fix-printer-driver', 'Second.'], {dir: v.dir, now: NOW});

    const file = v.read('next/fix-printer-driver.md');
    expect(file.indexOf('First.')).toBeLessThan(file.indexOf('Second.'));
  });

  test('--note says the same thing as a positional, for symmetry with the rest', async () => {
    const v = await seeded();
    const result = await omni(
      ['note', 'fix-printer-driver', '--note', 'Through the flag instead.'],
      {dir: v.dir, now: NOW},
    );

    expect(result.code).toBe(EXIT_OK);
    expect(v.read('next/fix-printer-driver.md')).toContain('Through the flag instead.');
  });
});

describe('notes it refuses to record', () => {
  test('an empty one, because a blank log line says nothing', async () => {
    const v = await seeded();
    const result = await omni(['note', 'fix-printer-driver'], {dir: v.dir, now: NOW});

    expect(result.code).toBe(EXIT_USAGE);
    expect(result.stderr).toContain('usage: omni note');
  });

  test('one on a task that is not there, with the ordinary not-found code', async () => {
    const v = await seeded();
    const result = await omni(['note', 'nope', 'Something.', '--json'], {dir: v.dir, now: NOW});

    expect(result.code).toBe(EXIT_NOT_FOUND);
    expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout)).toMatchObject({ok: false, code: EXIT_NOT_FOUND});
  });
});
