/**
 * Walking the weekly review in the interface.
 *
 * The walk is a guided tour of lists you already have, so the thing most worth checking
 * is that the ordinary keys still work inside it: finding a problem and being unable to
 * fix it without leaving would defeat the point of the ritual.
 */
import {afterEach, beforeEach, describe, expect, test} from 'bun:test';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
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

function seed(): void {
  vault.put('inbox/call-bank.md', taskFile({id: '0tq7f2k9aaaa', title: 'Call the bank'}));
  vault.put(
    'review/fix-printer.md',
    `${taskFile({id: '0tq7f2k9bbbb', title: 'Fix printer'})}\n## Log\n\n- ${NOW} **agent:claude-code** — Installed PPD 4.2.\n`,
  );
  vault.put('next/draft-memo.md', taskFile({id: '0tq7f2k9cccc', title: 'Draft the memo', tags: ['work']}));
  vault.put('someday/learn-welding.md', taskFile({id: '0tq7f2k9dddd', title: 'Learn welding'}));
  vault.put(
    'projects/active/kitchen.md',
    '---\nid: 0tq7g0a2cdef\ntitle: Renovate the kitchen\noutcome: Finished\ncreated: 2026-09-01T09:00:00Z\n---\n',
  );
}

const start = (): Tui => {
  tui = startTui(vault, {now: NOW});
  return tui;
};

describe('starting the walk', () => {
  test('W opens it on the first step', async () => {
    seed();
    const ui = start();

    await ui.press('W');

    expect(ui.frame()).toContain('weekly review 1/6');
    expect(ui.frame()).toContain('Empty the inbox');
    expect(ui.frame()).toContain('still to be thought about');
  });

  test('it shows the list that step is about', async () => {
    seed();
    const ui = start();

    await ui.press('W');
    expect(ui.frame()).toContain('Call the bank');
  });

  test('the prompt says what you are deciding', async () => {
    seed();
    const ui = start();
    await ui.press('W');
    expect(ui.frame()).toContain('is it actionable?');
  });

  test('the walk\'s keys are in the hint row, in place of the plain list\'s', async () => {
    seed();
    const ui = start();
    await ui.press('W');

    const frame = ui.frame();
    expect(frame).toContain('n next step');
    expect(frame).toContain('esc leave');
    expect(frame).not.toContain('/ filter');
    // Once, in the hint row, not a second time in the header.
    expect(frame.split('esc leave').length).toBe(2);
  });

  test('the status bar names the walk rather than counting a list', async () => {
    seed();
    const ui = start();
    await ui.press('W');
    expect(ui.frame().split('\n')[0]).toContain('weekly');
    expect(ui.frame()).not.toContain('shown');
  });

  test('a cleared step offers nothing to act on', async () => {
    vault.put('next/draft-memo.md', taskFile({id: '0tq7f2k9cccc', title: 'Draft the memo'}));
    const ui = start();
    await ui.press('W');

    expect(ui.frame()).toContain('clear');
    expect(ui.frame()).not.toContain('x done');
  });

  test('the project step offers nothing to act on, since it shows no tasks', async () => {
    seed();
    const ui = start();
    await ui.press('W', 'n', 'n', 'n', 'n');

    const frame = ui.frame();
    expect(frame).toContain('Check every project is moving');
    expect(frame).not.toContain('x done');
    expect(frame).not.toContain('0tq7f2k9');
  });
});

describe('moving through the steps', () => {
  test('n advances, and the list underneath follows', async () => {
    seed();
    const ui = start();

    await ui.press('W');
    await ui.press('n');

    expect(ui.frame()).toContain('weekly review 2/6');
    expect(ui.frame()).toContain('Check finished work');
    expect(ui.frame()).toContain('Fix printer');
    expect(ui.frame()).toContain('agent:claude-code');
  });

  test('b goes back', async () => {
    seed();
    const ui = start();

    await ui.press('W');
    await ui.press('n');
    await ui.press('b');

    expect(ui.frame()).toContain('weekly review 1/6');
  });

  test('b on the first step stays put rather than escaping', async () => {
    seed();
    const ui = start();

    await ui.press('W');
    await ui.press('b');

    expect(ui.frame()).toContain('weekly review 1/6');
  });

  test('every step can be reached', async () => {
    seed();
    const ui = start();
    await ui.press('W');

    const titles: string[] = [];
    for (let i = 0; i < 6; i++) {
      titles.push(ui.frame());
      if (i < 5) await ui.press('n');
    }

    expect(titles[0]).toContain('Empty the inbox');
    expect(titles[1]).toContain('Check finished work');
    expect(titles[2]).toContain('Review your next actions');
    expect(titles[3]).toContain('Chase what others owe you');
    expect(titles[4]).toContain('Check every project is moving');
    expect(titles[5]).toContain('Reconsider someday/maybe');
  });

  test('a clear step says so, so you can move past it quickly', async () => {
    seed();
    const ui = start();

    await ui.press('W');
    await ui.press('n', 'n', 'n');

    expect(ui.frame()).toContain('Chase what others owe you');
    expect(ui.frame()).toContain('clear');
  });

  test('escape leaves the walk', async () => {
    seed();
    const ui = start();

    await ui.press('W');
    await ui.press(ESC);

    expect(ui.frame()).not.toContain('weekly review');
  });
});

describe('acting on what the walk turns up', () => {
  // The whole point: finding a problem and being unable to fix it without leaving
  // would make the ritual something you avoid.
  test('you can accept reviewed work without leaving the walk', async () => {
    seed();
    const ui = start();

    await ui.press('W');
    await ui.press('n'); // the review step
    await ui.press('x');
    await ui.press(ENTER);

    expect(vault.exists('done/2026-09/fix-printer.md')).toBe(true);
    expect(ui.frame()).toContain('weekly review 2/6');
  });

  test('you can tag an untagged action in place', async () => {
    seed();
    const ui = start();

    await ui.press('W');
    await ui.press('n', 'n'); // the next-actions step
    await ui.press('t');
    await ui.type(' urgent');
    await ui.press(ENTER);

    expect(vault.read('next/draft-memo.md')).toContain('urgent');
  });

  test('the step updates as you clear it', async () => {
    seed();
    const ui = start();

    await ui.press('W');
    expect(ui.frame()).toContain('1 item still to be thought about');

    await ui.press('m');
    await ui.press('n'); // move the inbox item to next

    expect(ui.frame()).toContain('clear');
  });
});

describe('finishing', () => {
  test('advancing past the last step records the pass', async () => {
    seed();
    const ui = start();

    await ui.press('W');
    await ui.press('n', 'n', 'n', 'n', 'n', 'n');

    expect(ui.frame()).toContain('review recorded');
    expect(ui.frame()).not.toContain('weekly review 1/6');

    const log = readFileSync(join(vault.dir, 'REVIEW.md'), 'utf8');
    expect(log).toContain('# Weekly reviews');
    expect(log).toContain(NOW);
  });

  test('it stamps the active projects with the date', async () => {
    seed();
    const ui = start();

    await ui.press('W');
    await ui.press('n', 'n', 'n', 'n', 'n', 'n');

    expect(vault.read('projects/active/kitchen.md')).toContain('reviewed: 2026-09-12');
  });

  test('the last step says that advancing will finish', async () => {
    seed();
    const ui = start();

    await ui.press('W');
    await ui.press('n', 'n', 'n', 'n', 'n');

    expect(ui.frame()).toContain('weekly review 6/6');
    expect(ui.frame()).toContain('n finish and record');
  });
});
