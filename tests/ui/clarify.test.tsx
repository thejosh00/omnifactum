/**
 * The clarify walk, driven by real keys.
 *
 * What the walk *decides* is tested in `tests/unit/clarify.test.ts` against the reducer,
 * with no screen involved. These only prove the other half: that the keys reach it, that
 * the answers reach the files, and that the pass moves through the inbox rather than
 * asking about one item and stopping.
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

const start = (): Tui => {
  tui = startTui(vault, {now: NOW, list: 'inbox'});
  return tui;
};

function inbox(): void {
  vault.put('inbox/call-bank.md', taskFile({id: '0tq7f2k9aaaa', title: 'Call the bank'}));
}

function twoInTheInbox(): void {
  inbox();
  vault.put('inbox/old-magazines.md', taskFile({id: '0tq7f2k9bbbb', title: 'Old magazines'}));
}

describe('starting the walk', () => {
  test('C asks the first question about the item under the cursor', async () => {
    inbox();
    const app = start();

    await app.press('C');

    expect(app.frame()).toContain('Call the bank');
    expect(app.frame()).toContain('Is there anything to do about this?');
  });

  test('esc leaves without touching it', async () => {
    inbox();
    const app = start();

    await app.press('C', ESC);

    expect(vault.exists('inbox/call-bank.md')).toBe(true);
    expect(app.frame()).toContain('Call the bank');
  });
});

describe('an actionable item', () => {
  test('one action you own, with a context, lands in next', async () => {
    inbox();
    const app = start();

    await app.press('C', 'y', '1', 'm');
    expect(app.frame()).toContain('Where can it be done?');

    await app.type('calls');
    await app.press(ENTER);

    expect(vault.exists('next/call-bank.md')).toBe(true);
    const file = vault.read('next/call-bank.md');
    expect(file).toContain('tags: [calls]');
    expect(file).toContain('Clarified: this is the next action.');
  });

  test('delegating it asks who, and files it in waiting with the date', async () => {
    inbox();
    const app = start();

    await app.press('C', 'y', '1', 'd');
    expect(app.frame()).toContain('Who are you waiting on?');

    await app.type('Sam');
    await app.press(ENTER);
    await app.press(ENTER);

    const file = vault.read('waiting/call-bank.md');
    expect(file).toContain('waiting_on: Sam');
    expect(file).toContain(`asked: ${NOW}`);
    expect(file).toContain('Clarified: delegated to Sam.');
  });

  test('part of a project links it, and the link survives the move', async () => {
    inbox();
    const app = start();

    await app.press('C', 'y', 'p');
    expect(app.frame()).toContain('Which project?');

    await app.type('renovate-kitchen');
    await app.press(ENTER);
    await app.press('m', ENTER);

    const file = vault.read('next/call-bank.md');
    expect(file).toContain('project: renovate-kitchen');
  });
});

describe('an item with nothing to do about it', () => {
  test('someday keeps it, and says why in the log', async () => {
    inbox();
    const app = start();

    await app.press('C', 'n', 's');

    expect(vault.exists('someday/call-bank.md')).toBe(true);
    expect(vault.read('someday/call-bank.md')).toContain('kept as someday/maybe');
  });

  test('dropping it asks again first, because deletion is real', async () => {
    inbox();
    const app = start();

    await app.press('C', 'n', 'd');

    expect(app.frame()).toContain('There is no undo.');
    expect(vault.exists('inbox/call-bank.md')).toBe(true);
  });

  test('confirming the drop deletes the file', async () => {
    inbox();
    const app = start();

    await app.press('C', 'n', 'd', 'y');

    expect(vault.exists('inbox/call-bank.md')).toBe(false);
    expect(vault.list()).toEqual([]);
  });

  test('declining it goes back to the question rather than out of the walk', async () => {
    inbox();
    const app = start();

    await app.press('C', 'n', 'd', 'n');

    expect(app.frame()).toContain('Keep it or drop it?');
    expect(vault.exists('inbox/call-bank.md')).toBe(true);
  });
});

describe('correcting yourself mid-walk', () => {
  test('b re-asks the previous question', async () => {
    inbox();
    const app = start();

    await app.press('C', 'y', '1');
    expect(app.frame()).toContain('Who does it?');

    await app.press('b');
    expect(app.frame()).toContain('Is this one action');
  });

  test('and the second answer is the one that counts', async () => {
    inbox();
    const app = start();

    // Answered "nothing to do", thought better of it, then walked the actionable path.
    await app.press('C', 'n', 'b', 'y', '1', 'm', ENTER);

    expect(vault.exists('next/call-bank.md')).toBe(true);
    expect(vault.exists('someday/call-bank.md')).toBe(false);
  });

  test('a question answered by typing has no back, and says so', async () => {
    inbox();
    const app = start();

    // `b` there is a letter, not a key: the walk leaves the input row to the input.
    await app.press('C', 'y', 'p');
    expect(app.frame()).toContain('esc leave the walk');
    expect(app.frame()).not.toContain('b back');
  });
});

describe('emptying the inbox rather than clarifying one thing', () => {
  test('filing one opens the next straight away', async () => {
    twoInTheInbox();
    const app = start();

    await app.press('C', 'n', 's');

    expect(app.frame()).toContain('Old magazines');
    expect(app.frame()).toContain('Is there anything to do about this?');
  });

  test('and the walk ends when the inbox does', async () => {
    twoInTheInbox();
    const app = start();

    await app.press('C', 'n', 's', 'n', 's');

    expect(app.frame()).toContain('Inbox zero.');
    expect(vault.list().sort()).toEqual([
      'someday/call-bank.md',
      'someday/old-magazines.md',
    ]);
  });

  test('clarifying from the detail view handles that one task and stops', async () => {
    twoInTheInbox();
    const app = start();

    await app.press(ENTER, 'C', 'n', 's');

    expect(app.frame()).not.toContain('Is there anything to do about this?');
    expect(vault.exists('someday/call-bank.md')).toBe(true);
    expect(vault.exists('inbox/old-magazines.md')).toBe(true);
  });
});
