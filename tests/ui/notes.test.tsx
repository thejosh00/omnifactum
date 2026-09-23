/**
 * Notes in the interface: the `N` key, and the reason that has to travel with work
 * leaving the review queue.
 *
 * `m` then `n` on a reviewed task used to write "Moved to next." and nothing else, so
 * the agent that picked it up again had no way to find out what was wrong — which is the
 * one thing the review queue exists to convey.
 */
import {afterEach, beforeEach, describe, expect, test} from 'bun:test';
import {makeVault, taskFile, type Vault} from '../helpers/vault.ts';
import {ENTER, ESC, startTui, type Tui} from '../helpers/tui.tsx';

const NOW = '2026-09-12T11:03:00Z';

let vault: Vault;
let tui: Tui | undefined;

beforeEach(() => {
  vault = makeVault();
});

afterEach(() => {
  tui?.unmount();
  tui = undefined;
  vault.cleanup();
});

const start = (options?: Parameters<typeof startTui>[1]): Tui => {
  tui = startTui(vault, {now: NOW, ...options});
  return tui;
};

/** Work an agent has handed back, waiting for a person to look at it. */
function submitted(): void {
  vault.put(
    'review/fix-printer.md',
    taskFile(
      {id: '0tq7f2k9aaaa', title: 'Fix printer', tags: ['agent']},
      '\n## Log\n\n- 2026-09-12T10:04:00Z **agent:claude-code** — Installed vendor PPD 4.2.\n',
    ),
  );
}

describe('sending reviewed work back', () => {
  test('the row says whose work it is and how long it has waited', () => {
    submitted();
    const app = start({list: 'review'});
    expect(app.rows()[0]).toContain('agent:claude-code today');
  });

  test('the hints speak as a reviewer: accept, or send back', () => {
    submitted();
    const frame = start({list: 'review'}).frame();
    expect(frame).toContain('x accept');
    expect(frame).toContain('m send back');
    expect(frame).not.toContain('x done');
  });

  test('x accepts it, asking the reviewer the reviewer\'s question', async () => {
    submitted();
    const app = start({list: 'review'});

    await app.press('x');
    expect(app.frame()).toContain('accepting it');
    expect(app.frame()).not.toContain('what did you do?');

    await app.type('Looks right.');
    await app.press(ENTER);

    expect(vault.read('done/2026-09/fix-printer.md')).toContain('**you** — Looks right.');
    expect(app.frame()).toContain('done: Fix printer');
  });

  test('asks why before it moves anything', async () => {
    submitted();
    const app = start({list: 'review'});

    await app.press('m', 'n');

    expect(app.frame()).toContain('what was wrong?');
    // Nothing has moved yet: the question comes first.
    expect(vault.exists('review/fix-printer.md')).toBe(true);
  });

  test('and the reason reaches the log the agent will read', async () => {
    submitted();
    const app = start({list: 'review'});

    await app.press('m', 'n');
    await app.type('Still jams on duplex.');
    await app.press(ENTER);

    expect(vault.exists('next/fix-printer.md')).toBe(true);
    const file = vault.read('next/fix-printer.md');
    expect(file).toContain('**you** — Still jams on duplex.');
    // And what the agent said is still there above it.
    expect(file).toContain('Installed vendor PPD 4.2.');
  });

  test('accepting it asks too, so a check that found nothing is still recorded', async () => {
    submitted();
    const app = start({list: 'review'});

    await app.press('m', 'd');
    expect(app.frame()).toContain('accepting it');

    await app.type('Checked, prints clean.');
    await app.press(ENTER);

    expect(vault.read('done/2026-09/fix-printer.md')).toContain('**you** — Checked, prints clean.');
  });

  test('skipping the reason still moves it, rather than trapping you in the prompt', async () => {
    submitted();
    const app = start({list: 'review'});

    await app.press('m', 'n', ENTER);

    expect(vault.exists('next/fix-printer.md')).toBe(true);
    expect(vault.read('next/fix-printer.md')).toContain('Moved to next.');
  });

  test('escaping the prompt leaves the task where it was', async () => {
    submitted();
    const app = start({list: 'review'});

    await app.press('m', 'n', ESC);

    expect(vault.exists('review/fix-printer.md')).toBe(true);
  });

  test('a move that is not out of review stays one keystroke', async () => {
    vault.put('next/draft-memo.md', taskFile({id: '0tq7f2k9bbbb', title: 'Draft the memo'}));
    const app = start();

    await app.press('m', 'w');

    expect(vault.exists('waiting/draft-memo.md')).toBe(true);
  });
});

describe('the note key', () => {
  test('records what happened without changing the state', async () => {
    vault.put('next/draft-memo.md', taskFile({id: '0tq7f2k9bbbb', title: 'Draft the memo'}));
    const app = start();

    await app.press('N');
    expect(app.frame()).toContain('what happened?');

    await app.type('Outline agreed with Priya.');
    await app.press(ENTER);

    expect(vault.exists('next/draft-memo.md')).toBe(true);
    expect(vault.read('next/draft-memo.md')).toContain('**you** — Outline agreed with Priya.');
  });

  test('an empty note is a cancellation, not a blank line in the log', async () => {
    vault.put('next/draft-memo.md', taskFile({id: '0tq7f2k9bbbb', title: 'Draft the memo'}));
    const app = start();

    await app.press('N', ENTER);

    expect(vault.read('next/draft-memo.md')).not.toContain('## Log');
  });

  test('works from the detail view, on the task you opened', async () => {
    vault.put('next/draft-memo.md', taskFile({id: '0tq7f2k9bbbb', title: 'Draft the memo'}));
    const app = start();

    await app.press(ENTER, 'N');
    await app.type('Read it back.');
    await app.press(ENTER);

    expect(vault.read('next/draft-memo.md')).toContain('**you** — Read it back.');
  });
});
