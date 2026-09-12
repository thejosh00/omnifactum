/**
 * What the interface does while an agent works the same list.
 *
 * The agent here is the real CLI, so these exercise the lock, the diff, and the
 * rendering together. Each `refreshFromDisk` stands in for the watcher firing; the
 * watcher itself is covered in `tests/store/watch.test.ts`, and that it reaches the
 * interface at all is checked by hand against a real terminal.
 */
import {afterEach, beforeEach, describe, expect, test} from 'bun:test';
import {makeVault, taskFile, type Vault} from '../helpers/vault.ts';
import {ENTER, ESC, startTui, type Tui} from '../helpers/tui.tsx';
import {omni} from '../helpers/cli.ts';

const NOW = '2026-09-12T11:03:00Z';
const AGENT = 'agent:claude-code';

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

function seed(): void {
  vault.put('next/fix-printer.md', taskFile({id: '0tq7f2k9aaaa', title: 'Fix printer', tags: ['agent']}));
  vault.put('next/draft-memo.md', taskFile({id: '0tq7f2k9bbbb', title: 'Draft the memo'}));
  vault.put('next/call-bank.md', taskFile({id: '0tq7f2k9cccc', title: 'Call the bank'}));
}

/** An agent does something, through the CLI, exactly as it would in another terminal. */
async function agent(args: string[]): Promise<void> {
  await omni([...args, '--actor', AGENT], {dir: vault.dir, now: NOW});
}

/**
 * You, in another terminal. Used where the scenario needs a genuine completion, since
 * an agent is not allowed to accept its own work.
 */
async function elsewhere(args: string[]): Promise<void> {
  await omni(args, {dir: vault.dir, now: NOW});
}

const start = (): Tui => {
  tui = startTui(vault, {now: NOW});
  return tui;
};

const cursorLine = (ui: Tui): string => ui.frame().split('\n').find(l => l.includes('❯')) ?? '';

describe('being told what happened', () => {
  test('work submitted by an agent is announced, with the note and the actor', async () => {
    seed();
    const ui = start();

    await agent(['submit', 'fix-printer', '--note', 'Installed PPD 4.2.']);
    ui.live.refreshFromDisk();
    await ui.press('j');

    expect(ui.frame()).toContain('"Fix printer" moved to review by agent:claude-code');
    expect(ui.frame()).toContain('Installed PPD 4.2.');
  });

  test('a genuine completion from another terminal is announced too', async () => {
    seed();
    const ui = start();

    await elsewhere(['done', 'fix-printer', '--note', 'Checked and accepted.']);
    ui.live.refreshFromDisk();
    await ui.press('j');

    expect(ui.frame()).toContain('"Fix printer" was completed');
  });

  test('a task captured by an agent is announced', async () => {
    seed();
    const ui = start();

    await agent(['add', 'Something new', '--next']);
    ui.live.refreshFromDisk();
    await ui.press('j');

    expect(ui.frame()).toContain('"Something new" was added');
  });

  test('a move is announced with its destination', async () => {
    seed();
    const ui = start();

    await agent(['mv', 'fix-printer', 'waiting']);
    ui.live.refreshFromDisk();
    await ui.press('j');

    expect(ui.frame()).toContain('moved to waiting');
  });

  test('several changes at once are counted rather than spammed', async () => {
    seed();
    const ui = start();

    await elsewhere(['done', 'fix-printer', '--note', 'a']);
    await elsewhere(['done', 'draft-memo', '--note', 'b']);
    ui.live.refreshFromDisk();
    await ui.press('j');

    expect(ui.frame()).toContain('2 tasks were completed elsewhere');
  });

  test('your own edits are not announced back at you', async () => {
    seed();
    const ui = start();

    await ui.press('t');
    await ui.type('mine');
    await ui.press(ENTER);

    expect(ui.frame()).toContain('tags updated');
    expect(ui.frame()).not.toContain('was edited');
  });
});

describe('the list keeps its place', () => {
  test('the completed row goes, and the cursor lands on its neighbour', async () => {
    seed();
    const ui = start();
    expect(cursorLine(ui)).toContain('Fix printer');

    await elsewhere(['done', 'fix-printer', '--note', 'done']);
    ui.live.refreshFromDisk();
    await new Promise(r => setTimeout(r, 30));

    const rows = ui.rows();
    expect(rows.join('\n')).not.toContain('Fix printer');
    expect(rows.join('\n')).toContain('Draft the memo');
    expect(cursorLine(ui)).toContain('Draft the memo');
  });
});

describe('the detail view stays on the task you opened', () => {
  // The bug this replaced: the detail view followed the cursor, so a task completed by
  // an agent dropped out of the list and the screen silently started showing a
  // different task's fields under the same heading.
  test('a task completed while you read it stays on screen, showing its new state', async () => {
    seed();
    const ui = start();

    await ui.press(ENTER);
    expect(ui.frame()).toContain('0tq7f2k9aaaa');
    expect(ui.frame()).toContain('Fix printer');

    await agent(['submit', 'fix-printer', '--note', 'Installed PPD 4.2.']);
    ui.live.refreshFromDisk();
    await new Promise(r => setTimeout(r, 30));

    // Same task, not a neighbour.
    expect(ui.frame()).toContain('0tq7f2k9aaaa');
    expect(ui.frame()).toContain('Fix printer');
    expect(ui.frame()).not.toContain('Draft the memo');

    // And it tells the truth about what it has become. Matched on the field row, since
    // the word "done" also appears in the status bar's counts.
    const stateRow = ui.frame().split('\n').find(line => line.trimStart().startsWith('state'));
    expect(stateRow).toContain('review');
    expect(ui.frame()).toContain('agent:claude-code');
    expect(ui.frame()).toContain('Installed PPD 4.2.');
  });

  test('acting from the detail view acts on that task, not on the cursor', async () => {
    seed();
    const ui = start();

    await ui.press(ENTER); // open "Fix printer"
    await agent(['mv', 'fix-printer', 'waiting']); // it leaves the next list
    ui.live.refreshFromDisk();
    await new Promise(r => setTimeout(r, 30));

    await ui.press('t');
    await ui.type(' mine');
    await ui.press(ENTER);

    // The tag must land on the task that was open, wherever it now lives.
    expect(vault.read('waiting/fix-printer.md')).toContain('mine');
    expect(vault.read('next/draft-memo.md')).not.toContain('mine');
  });

  test('a task deleted while you read it drops back to the list and says so', async () => {
    seed();
    const ui = start();

    await ui.press(ENTER);
    await agent(['rm', 'fix-printer', '--yes']);
    ui.live.refreshFromDisk();
    await new Promise(r => setTimeout(r, 30));

    expect(ui.frame()).toContain('deleted by someone else');
    expect(ui.frame()).toContain('Draft the memo');
  });

  test('escape still returns to the list and unpins', async () => {
    seed();
    const ui = start();

    await ui.press(ENTER);
    await ui.press(ESC);
    expect(ui.frame()).toContain('Call the bank');

    // Back on the list, actions apply to the cursor again.
    await ui.press('t');
    await ui.type('cursor');
    await ui.press(ENTER);
    expect(vault.read('next/fix-printer.md')).toContain('cursor');
  });
});

describe('racing an agent', () => {
  test('completing something it already finished is refused, not repeated', async () => {
    seed();
    const ui = start();

    await elsewhere(['done', 'fix-printer', '--note', 'got there first']);
    // Deliberately stale: no refresh, as the screen would be for a moment.
    await ui.press('x');
    await ui.press(ENTER);

    expect(ui.frame()).toContain('completed by someone else first');
    expect(vault.read('done/2026-09/fix-printer.md')).toContain('got there first');
  });

  test('tagging a task it just moved still lands on the right file', async () => {
    seed();
    const ui = start();

    await agent(['mv', 'fix-printer', 'someday']);
    await ui.press('t');
    await ui.type(' mine');
    await ui.press(ENTER);

    expect(vault.exists('someday/fix-printer.md')).toBe(true);
    expect(vault.read('someday/fix-printer.md')).toContain('mine');
  });
});
