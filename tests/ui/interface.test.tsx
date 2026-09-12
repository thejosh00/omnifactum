/**
 * The interactive interface, driven by real key sequences against a real vault.
 *
 * Assertions are on substrings rather than whole-frame snapshots: colour and width make
 * Ink snapshots miserably brittle, and a snapshot tells you a frame changed without
 * telling you whether it changed correctly.
 */
import {afterEach, beforeEach, describe, expect, test} from 'bun:test';
import {makeVault, taskFile, type Vault} from '../helpers/vault.ts';
import {ARROW_DOWN, ENTER, ESC, startTui, type Tui} from '../helpers/tui.tsx';

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

function seed(): void {
  vault.put('next/fix-printer.md', taskFile({id: '0tq7f2k9aaaa', title: 'Fix printer', tags: ['home', 'agent']}));
  vault.put('next/draft-memo.md', taskFile({id: '0tq7f2k9bbbb', title: 'Draft the memo', tags: ['work']}));
  vault.put('inbox/call-bank.md', taskFile({id: '0tq7f2k9cccc', title: 'Call the bank'}));
}

const start = (options?: Parameters<typeof startTui>[1]): Tui => {
  tui = startTui(vault, {now: NOW, ...options});
  return tui;
};

describe('the first frame', () => {
  test('shows the next list with counts', () => {
    seed();
    const frame = start().frame();
    expect(frame).toContain('Fix printer');
    expect(frame).toContain('Draft the memo');
    // The key and the count are spaced away from the name so the row is scannable.
    expect(frame).toContain('2 next 2');
    expect(frame).toContain('1 inbox 1');
  });

  test('shows tags alongside each task', () => {
    seed();
    expect(start().frame()).toContain('#home');
  });

  test('an empty list says so rather than showing nothing', () => {
    expect(start().frame()).toContain('Nothing to do right now.');
  });

  test('the cursor starts on the first row', () => {
    seed();
    const frame = start().frame();
    const cursorLine = frame.split('\n').find(line => line.includes('❯'));
    expect(cursorLine).toContain('Fix printer');
  });
});

describe('moving around', () => {
  test('j and k move the cursor', async () => {
    seed();
    const ui = start();

    await ui.press('j');
    expect(ui.frame().split('\n').find(l => l.includes('❯'))).toContain('Draft the memo');

    await ui.press('k');
    expect(ui.frame().split('\n').find(l => l.includes('❯'))).toContain('Fix printer');
  });

  test('the arrow keys do the same', async () => {
    seed();
    const ui = start();
    await ui.press(ARROW_DOWN);
    expect(ui.frame().split('\n').find(l => l.includes('❯'))).toContain('Draft the memo');
  });

  test('the cursor stops at the end rather than wrapping', async () => {
    seed();
    const ui = start();
    await ui.press('j', 'j', 'j', 'j');
    expect(ui.frame().split('\n').find(l => l.includes('❯'))).toContain('Draft the memo');
  });

  test('the number keys switch lists', async () => {
    seed();
    const ui = start();
    await ui.press('1');
    expect(ui.frame()).toContain('Call the bank');
    expect(ui.frame()).not.toContain('Fix printer');
  });
});

describe('filtering', () => {
  test('/ narrows the list by tag', async () => {
    seed();
    const ui = start();

    await ui.press('/');
    await ui.type('work');
    await ui.press(ENTER);

    expect(ui.frame()).toContain('Draft the memo');
    expect(ui.frame()).not.toContain('Fix printer');
    expect(ui.frame()).toContain('/work');
  });

  test('a negated filter excludes', async () => {
    seed();
    const ui = start();

    await ui.press('/');
    await ui.type('-work');
    await ui.press(ENTER);

    expect(ui.frame()).toContain('Fix printer');
    expect(ui.frame()).not.toContain('Draft the memo');
  });

  test('escape clears the filter', async () => {
    seed();
    const ui = start();

    await ui.press('/');
    await ui.type('work');
    await ui.press(ENTER);
    await ui.press(ESC);

    expect(ui.frame()).toContain('Fix printer');
    expect(ui.frame()).toContain('Draft the memo');
  });

  test('escape while typing abandons the filter without applying it', async () => {
    seed();
    const ui = start();

    await ui.press('/');
    await ui.type('work');
    await ui.press(ESC);

    expect(ui.frame()).toContain('Fix printer');
  });

  test('a filter matching nothing says so', async () => {
    seed();
    const ui = start();

    await ui.press('/');
    await ui.type('nonexistent');
    await ui.press(ENTER);

    expect(ui.frame()).toContain('Nothing to do right now.');
  });
});

describe('capturing', () => {
  test('c captures into the inbox and writes a file', async () => {
    const ui = start();

    await ui.press('c');
    await ui.type('Buy milk on the way home');
    await ui.press(ENTER);

    expect(ui.frame()).toContain('captured into inbox');
    expect(vault.list()).toEqual(['inbox/buy-milk-on-the-way-home.md']);
  });

  test('inline tags in the captured line become real tags', async () => {
    const ui = start();

    await ui.press('c');
    await ui.type('Buy milk #errands');
    await ui.press(ENTER);

    expect(vault.read('inbox/buy-milk.md')).toContain('tags: [errands]');
  });

  test('escape abandons the capture without writing anything', async () => {
    const ui = start();

    await ui.press('c');
    await ui.type('Never mind');
    await ui.press(ESC);

    expect(vault.list()).toEqual([]);
  });

  test('an empty capture writes nothing', async () => {
    const ui = start();
    await ui.press('c');
    await ui.press(ENTER);
    expect(vault.list()).toEqual([]);
  });
});

describe('completing a task', () => {
  test('x asks for a note, then files it under the month', async () => {
    seed();
    const ui = start();

    await ui.press('x');
    expect(ui.frame()).toContain('what did you do?');

    await ui.type('Installed the vendor driver');
    await ui.press(ENTER);

    expect(ui.frame()).toContain('done: Fix printer');
    expect(vault.exists('done/2026-09/fix-printer.md')).toBe(true);

    const written = vault.read('done/2026-09/fix-printer.md');
    expect(written).toContain('done: 2026-09-12T11:03:00Z');
    expect(written).toContain('**you** — Installed the vendor driver');
  });

  test('the note can be skipped', async () => {
    seed();
    const ui = start();

    await ui.press('x');
    await ui.press(ENTER);

    expect(vault.exists('done/2026-09/fix-printer.md')).toBe(true);
    expect(vault.read('done/2026-09/fix-printer.md')).toContain('Completed.');
  });

  test('the completed task leaves the list and the cursor lands on the next one', async () => {
    seed();
    const ui = start();

    await ui.press('x');
    await ui.press(ENTER);

    // The banner still names the task, so check the rows rather than the whole frame.
    const rows = ui.rows();
    expect(rows.join('\n')).not.toContain('Fix printer');
    expect(rows.join('\n')).toContain('Draft the memo');
    expect(rows).toHaveLength(1);
    expect(ui.frame().split('\n').find(l => l.includes('❯'))).toContain('Draft the memo');
  });
});

describe('moving a task between lists', () => {
  test('m then a letter moves it', async () => {
    seed();
    const ui = start();

    await ui.press('m');
    expect(ui.frame()).toContain('move to');

    await ui.press('w');
    expect(ui.frame()).toContain('moved to waiting');
    expect(vault.exists('waiting/fix-printer.md')).toBe(true);
  });

  test('escape cancels without moving anything', async () => {
    seed();
    const ui = start();

    await ui.press('m');
    await ui.press(ESC);

    expect(vault.exists('next/fix-printer.md')).toBe(true);
  });
});

describe('editing tags', () => {
  const CTRL_U = String.fromCharCode(21);
  const CTRL_W = String.fromCharCode(23);

  test('the field is pre-filled with the tags the task already has', async () => {
    seed();
    const ui = start();

    await ui.press('t');
    expect(ui.frame()).toContain('#home #agent');
  });

  test('ctrl-u clears the field so a fresh set can be typed', async () => {
    seed();
    const ui = start();

    await ui.press('t');
    await ui.press(CTRL_U);
    await ui.type('urgent');
    await ui.press(ENTER);

    expect(ui.frame()).toContain('tags updated');
    expect(vault.read('next/fix-printer.md')).toContain('tags: [urgent]');
  });

  test('ctrl-w drops the last tag', async () => {
    seed();
    const ui = start();

    await ui.press('t');
    await ui.press(CTRL_W);
    await ui.press(ENTER);

    expect(vault.read('next/fix-printer.md')).toContain('tags: [home]');
  });

  test('a leading minus removes one tag and keeps the rest', async () => {
    seed();
    const ui = start();

    await ui.press('t');
    await ui.press(CTRL_U);
    await ui.type('-agent');
    await ui.press(ENTER);

    expect(vault.read('next/fix-printer.md')).toContain('tags: [home]');
  });
});

describe('deleting, which has no undo', () => {
  test('X asks first and says so plainly', async () => {
    seed();
    const ui = start();

    await ui.press('X');
    expect(ui.frame()).toContain('permanently');
    expect(ui.frame()).toContain('no undo');
    expect(vault.exists('next/fix-printer.md')).toBe(true);
  });

  test('n keeps the task', async () => {
    seed();
    const ui = start();

    await ui.press('X');
    await ui.press('n');

    expect(vault.exists('next/fix-printer.md')).toBe(true);
  });

  test('y deletes it', async () => {
    seed();
    const ui = start();

    await ui.press('X');
    await ui.press('y');

    expect(ui.frame()).toContain('deleted fix-printer');
    expect(vault.exists('next/fix-printer.md')).toBe(false);
  });
});

describe('the detail view', () => {
  test('enter opens the selected task in full', async () => {
    seed();
    vault.put(
      'next/fix-printer.md',
      taskFile({id: '0tq7f2k9aaaa', title: 'Fix printer', tags: ['home']}) +
        '\nThe driver crashes.\n\n## Log\n\n- 2026-09-12T10:00:00Z **agent:claude-code** — Looked at it.\n',
    );
    const ui = start();

    await ui.press(ENTER);

    expect(ui.frame()).toContain('0tq7f2k9aaaa');
    expect(ui.frame()).toContain('The driver crashes.');
    expect(ui.frame()).toContain('agent:claude-code');
    expect(ui.frame()).toContain('Looked at it.');
  });

  test('escape goes back to the list', async () => {
    seed();
    const ui = start();

    await ui.press(ENTER);
    await ui.press(ESC);

    expect(ui.frame()).toContain('Draft the memo');
  });

  test('editing from the detail view returns to it, not to the list', async () => {
    seed();
    const ui = start();

    await ui.press(ENTER);
    await ui.press('t');
    await ui.type(' urgent');
    await ui.press(ENTER);

    // Still reading the same task, rather than dumped back on the list.
    expect(ui.frame()).toContain('0tq7f2k9aaaa');
    expect(ui.frame()).toContain('esc back');
    expect(vault.read('next/fix-printer.md')).toContain('urgent');
  });

  test('a task can be completed from the detail view', async () => {
    seed();
    const ui = start();

    await ui.press(ENTER);
    await ui.press('x');
    await ui.press(ENTER);

    expect(vault.exists('done/2026-09/fix-printer.md')).toBe(true);
  });
});

describe('the projects view', () => {
  test('p shows projects, with the stalled ones called out', async () => {
    vault.put(
      'projects/active/kitchen.md',
      '---\nid: 0tq7g0a2cdef\ntitle: Renovate the kitchen\noutcome: Finished\ncreated: 2026-09-01T09:00:00Z\n---\n',
    );
    const ui = start();

    await ui.press('p');
    expect(ui.frame()).toContain('kitchen');
    expect(ui.frame()).toContain('stalled');
  });

  test('a project with a next action is not stalled', async () => {
    vault.put(
      'projects/active/kitchen.md',
      '---\nid: 0tq7g0a2cdef\ntitle: Renovate the kitchen\noutcome: Finished\ncreated: 2026-09-01T09:00:00Z\n---\n',
    );
    vault.put(
      'next/tiles.md',
      taskFile({id: '0tq7f2k9aaaa', title: 'Order tiles', extra: 'project: kitchen'}),
    );
    const ui = start();

    await ui.press('p');
    expect(ui.frame()).toContain('1 live');
    expect(ui.frame()).not.toContain('stalled');
  });

  test('with no projects it explains what one is for', async () => {
    const ui = start();
    await ui.press('p');
    expect(ui.frame()).toContain('more than one action');
  });
});

describe('help', () => {
  test('? lists the keys, generated from the keymap itself', async () => {
    const ui = start();
    await ui.press('?');

    expect(ui.frame()).toContain('Moving around');
    expect(ui.frame()).toContain('capture into the inbox');
    expect(ui.frame()).toContain('delete permanently');
  });

  test('any key dismisses it, so it is never a place to get stuck', async () => {
    const ui = start();
    await ui.press('?');
    await ui.press('z');
    expect(ui.frame()).not.toContain('Moving around');
  });
});

describe('changes made behind the interface', () => {
  test('r rereads the directory', async () => {
    seed();
    const ui = start();
    expect(ui.frame()).not.toContain('Added elsewhere');

    vault.put('next/elsewhere.md', taskFile({id: '0tq7f2k9dddd', title: 'Added elsewhere'}));
    await ui.press('r');

    expect(ui.frame()).toContain('Added elsewhere');
  });

  test('a task an agent completed disappears on the next read', async () => {
    seed();
    const ui = start();

    // Exactly what an agent does: move the file, append to the log.
    vault.put(
      'done/2026-09/fix-printer.md',
      taskFile({id: '0tq7f2k9aaaa', title: 'Fix printer'}) +
        '\n## Log\n\n- 2026-09-12T11:00:00Z **agent:claude-code** — Done.\n',
    );
    const {rmSync} = await import('node:fs');
    rmSync(`${vault.dir}/next/fix-printer.md`);

    await ui.press('r');

    expect(ui.frame()).not.toContain('Fix printer');
    expect(ui.frame()).toContain('Draft the memo');
  });

  test('the cursor survives a task vanishing from under it', async () => {
    seed();
    const ui = start();

    const {rmSync} = await import('node:fs');
    rmSync(`${vault.dir}/next/fix-printer.md`);
    await ui.press('r');

    expect(ui.frame().split('\n').find(l => l.includes('❯'))).toContain('Draft the memo');
  });
});

describe('quitting', () => {
  test('q quits from the list', async () => {
    seed();
    const ui = start();
    expect(ui.exited()).toBe(false);

    await ui.press('q');
    expect(ui.exited()).toBe(true);
  });

  test('q quits from the detail view too', async () => {
    seed();
    const ui = start();

    await ui.press(ENTER);
    await ui.press('q');

    expect(ui.exited()).toBe(true);
  });

  test('escape from the detail view goes back rather than quitting', async () => {
    seed();
    const ui = start();

    await ui.press(ENTER);
    await ui.press(ESC);

    expect(ui.exited()).toBe(false);
    expect(ui.frame()).toContain('Draft the memo');
  });

  test('q does not quit out of an input, where it is just a letter', async () => {
    const ui = start();

    await ui.press('c');
    await ui.type('quick note');
    expect(ui.exited()).toBe(false);

    await ui.press(ESC);
  });

  test('q dismisses help rather than quitting, so help is never a trap', async () => {
    seed();
    const ui = start();

    await ui.press('?');
    await ui.press('q');

    expect(ui.exited()).toBe(false);
    expect(ui.frame()).toContain('Fix printer');
  });
});

describe('the layout holds together', () => {
  function varied(): void {
    vault.put('next/a.md', taskFile({id: '0tq7f2k9aaaa', title: 'Short', tags: ['home']}));
    vault.put(
      'next/b.md',
      taskFile({
        id: '0tq7f2k9bbbb',
        title: 'A rather longer title that goes on a while',
        tags: ['work', 'writing', 'urgent'],
        extra: 'due: 2026-09-14',
      }),
    );
    vault.put(
      'next/c.md',
      taskFile({id: '0tq7f2k9cccc', title: 'Middling', extra: 'project: renovate-the-kitchen'}),
    );
  }

  /** The rule under the status bar spans the terminal, so it measures the width. */
  const widthOf = (ui: Tui): number =>
    ui.frame().split('\n').find(line => line.trim().startsWith('─'))!.length;

  // An overflowing row is not clipped by Ink, it is reflowed — and a reflowed row starts
  // swallowing the spaces between words, so the whole list stops lining up.
  test('no row runs past the terminal width', () => {
    varied();
    const ui = start();
    const width = widthOf(ui);

    for (const line of ui.frame().split('\n')) {
      expect({line, over: line.length > width}).toEqual({line, over: false});
    }
  });

  test('every row begins with the same cursor gutter, so titles align', () => {
    varied();
    const ui = start();
    const gutters = new Set(ui.rows().map(row => row.slice(0, 2)));

    expect([...gutters].every(gutter => /^[❯ ] $/.test(gutter))).toBe(true);
    expect(gutters.size).toBeLessThanOrEqual(2); // the selected row, and the rest
  });

  test('the annotations line up, whatever the title length', () => {
    varied();
    const ui = start();
    const marks = ui
      .rows()
      .map(row => row.search(/[#+]/))
      .filter(index => index > 0);

    expect(marks.length).toBeGreaterThan(1);
    expect(new Set(marks).size).toBe(1);
  });

  test('a long title is truncated rather than pushing the row over', () => {
    vault.put(
      'next/long.md',
      taskFile({
        id: '0tq7f2k9aaaa',
        title: 'An extremely long title that could not possibly fit inside any sensible column at all',
        tags: ['home'],
      }),
    );
    const ui = start();
    expect(ui.frame()).toContain('…');
    expect(ui.rows()[0]!.length).toBeLessThanOrEqual(widthOf(ui));
  });

  test('the id of the selected task is reachable, just not on every row', () => {
    varied();
    const ui = start();
    expect(ui.rows().join('\n')).not.toContain('0tq7f2k9');
    expect(ui.frame()).toContain('0tq7f2k9aaaa');
  });
});
