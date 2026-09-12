/**
 * Delegations, and the one check the weekly review makes that you could not make
 * yourself by looking.
 *
 * "Has this been sitting with someone for over a week?" needs a date for when you asked.
 * The field existed, the review read it, and nothing ever wrote it — so the check could
 * only fire for someone who had typed `asked:` into the frontmatter by hand, and in
 * practice never fired at all.
 */
import {afterEach, describe, expect, test} from 'bun:test';
import {STALE_WAITING_DAYS} from '../../src/core/review.ts';
import {makeVault, type Vault} from '../helpers/vault.ts';
import {omni} from '../helpers/cli.ts';

const ASKED = '2026-09-01T09:00:00Z';
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

async function started(): Promise<Vault> {
  const v = openVault();
  await omni(['init'], {dir: v.dir, now: NOW});
  return v;
}

describe('asking someone for something', () => {
  test('omni add --waiting records when you asked', async () => {
    const v = await started();
    await omni(['add', 'Quote from the builder', '--waiting', '-w', 'Sam'], {
      dir: v.dir,
      now: ASKED,
    });

    const [task] = JSON.parse(
      (await omni(['waiting', '--json'], {dir: v.dir, now: NOW})).stdout,
    ) as Array<{asked?: string; waiting_on?: string}>;

    expect(task?.asked).toBe(ASKED);
    expect(task?.waiting_on).toBe('Sam');
  });

  test('so does moving something into waiting', async () => {
    const v = await started();
    await omni(['add', 'Quote from the builder', '--next'], {dir: v.dir, now: ASKED});
    await omni(['mv', 'quote-from-the-builder', 'waiting'], {dir: v.dir, now: ASKED});

    expect(v.read('waiting/quote-from-the-builder.md')).toContain(`asked: ${ASKED}`);
  });

  test('and it is written where a person reading the file can see it', async () => {
    const v = await started();
    await omni(['add', 'Quote from the builder', '--waiting'], {dir: v.dir, now: ASKED});

    const file = v.read('waiting/quote-from-the-builder.md');
    expect(file).toContain('asked: 2026-09-01T09:00:00Z');
  });

  test('the delegation ends when the task leaves waiting', async () => {
    const v = await started();
    await omni(['add', 'Quote from the builder', '--waiting', '-w', 'Sam'], {
      dir: v.dir,
      now: ASKED,
    });
    await omni(['mv', 'quote-from-the-builder', 'next'], {dir: v.dir, now: NOW});

    const file = v.read('next/quote-from-the-builder.md');
    expect(file).not.toContain('asked:');
    expect(file).not.toContain('waiting_on:');
  });
});

describe('the weekly review noticing a stale delegation', () => {
  test('says how long it has been and asks whether to chase it', async () => {
    const v = await started();
    await omni(['add', 'Quote from the builder', '--waiting', '-w', 'Sam'], {
      dir: v.dir,
      now: ASKED,
    });

    const weekly = await omni(['weekly'], {dir: v.dir, now: NOW});
    expect(weekly.stdout).toContain('chase it?');
    expect(weekly.stdout).toContain('Quote from the builder');
  });

  test('and says nothing about one you only just asked for', async () => {
    const v = await started();
    await omni(['add', 'Quote from the builder', '--waiting', '-w', 'Sam'], {
      dir: v.dir,
      now: NOW,
    });

    expect((await omni(['weekly'], {dir: v.dir, now: NOW})).stdout).not.toContain('chase it?');
  });

  test('the boundary is the documented one, not a day either side', async () => {
    const v = await started();
    await omni(['add', 'Quote from the builder', '--waiting'], {dir: v.dir, now: ASKED});

    const day = (offset: number): string => {
      const at = new Date(ASKED);
      at.setUTCDate(at.getUTCDate() + offset);
      return at.toISOString().replace('.000Z', 'Z');
    };

    const justBefore = await omni(['weekly'], {dir: v.dir, now: day(STALE_WAITING_DAYS - 1)});
    expect(justBefore.stdout).not.toContain('chase it?');

    const onTheDay = await omni(['weekly'], {dir: v.dir, now: day(STALE_WAITING_DAYS)});
    expect(onTheDay.stdout).toContain('chase it?');
  });
});
