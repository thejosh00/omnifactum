import {describe, expect, test} from 'bun:test';
import {BINDINGS, GROUP_TITLES, bindingsFor, intentFor} from '../../src/ui/keymap.ts';
import type {KeyEvent} from '../../src/ui/keymap.ts';

const key = (overrides: Partial<KeyEvent> & {input?: string} = {}): KeyEvent => ({
  input: '',
  ...overrides,
});

describe('the keymap table', () => {
  test('every binding is documented and grouped', () => {
    for (const binding of BINDINGS) {
      expect(binding.keys.length).toBeGreaterThan(0);
      expect(binding.label.length).toBeGreaterThan(0);
      expect(GROUP_TITLES[binding.group]).toBeDefined();
      expect(binding.modes.length).toBeGreaterThan(0);
    }
  });

  test('no intent is bound twice', () => {
    const intents = BINDINGS.map(b => b.intent);
    expect(new Set(intents).size).toBe(intents.length);
  });

  test('the list mode offers a way to move, act, filter and quit', () => {
    const groups = new Set(bindingsFor('list').map(b => b.group));
    expect(groups).toEqual(new Set(['moving', 'acting', 'filtering', 'lists', 'other']));
  });
});

describe('what a keypress means', () => {
  test('the movement keys', () => {
    expect(intentFor(key({input: 'j'}), 'list')).toBe('move-down');
    expect(intentFor(key({input: 'k'}), 'list')).toBe('move-up');
    expect(intentFor(key({downArrow: true}), 'list')).toBe('move-down');
    expect(intentFor(key({upArrow: true}), 'list')).toBe('move-up');
    expect(intentFor(key({input: 'g'}), 'list')).toBe('go-top');
    expect(intentFor(key({input: 'G'}), 'list')).toBe('go-bottom');
  });

  test('ctrl-d and ctrl-u page, and are not confused with plain d and u', () => {
    expect(intentFor(key({input: 'd', ctrl: true}), 'list')).toBe('page-down');
    expect(intentFor(key({input: 'u', ctrl: true}), 'list')).toBe('page-up');
    expect(intentFor(key({input: 'd'}), 'list')).toBeUndefined();
  });

  test('the acting keys', () => {
    expect(intentFor(key({input: 'x'}), 'list')).toBe('complete');
    expect(intentFor(key({input: 'c'}), 'list')).toBe('capture');
    expect(intentFor(key({input: 't'}), 'list')).toBe('edit-tags');
    expect(intentFor(key({input: 'm'}), 'list')).toBe('move-state');
    expect(intentFor(key({input: 'e'}), 'list')).toBe('open-editor');
  });

  // There is no undo anywhere in this app, so deleting must not be a neighbour of
  // anything common, and must not be a lowercase letter.
  test('delete is a capital, and lowercase x completes instead', () => {
    expect(intentFor(key({input: 'X'}), 'list')).toBe('delete');
    expect(intentFor(key({input: 'x'}), 'list')).not.toBe('delete');
  });

  test('enter opens and escape clears the filter from the list', () => {
    expect(intentFor(key({return: true}), 'list')).toBe('open');
    expect(intentFor(key({escape: true}), 'list')).toBe('clear-filter');
  });

  test('escape goes back from anywhere else', () => {
    expect(intentFor(key({escape: true}), 'detail')).toBe('back');
    expect(intentFor(key({escape: true}), 'projects')).toBe('back');
  });

  test('the number keys pick a list', () => {
    expect(intentFor(key({input: '1'}), 'list')).toBe('list-inbox');
    expect(intentFor(key({input: '2'}), 'list')).toBe('list-next');
    expect(intentFor(key({input: '3'}), 'list')).toBe('list-waiting');
    expect(intentFor(key({input: '4'}), 'list')).toBe('list-someday');
    expect(intentFor(key({input: '5'}), 'list')).toBe('list-review');
    expect(intentFor(key({input: '6'}), 'list')).toBe('list-done');
  });

  test('an unbound key means nothing', () => {
    expect(intentFor(key({input: 'z'}), 'list')).toBeUndefined();
    expect(intentFor(key({input: ''}), 'list')).toBeUndefined();
  });
});

describe('a key only works where it makes sense', () => {
  test('filtering is a list thing, not a detail thing', () => {
    expect(intentFor(key({input: '/'}), 'list')).toBe('focus-filter');
    expect(intentFor(key({input: '/'}), 'detail')).toBeUndefined();
  });

  test('the detail view cannot open something inside itself', () => {
    expect(intentFor(key({return: true}), 'detail')).toBeUndefined();
  });

  test('q quits from anywhere you are just looking at something', () => {
    for (const mode of ['list', 'detail', 'projects'] as const) {
      expect(intentFor(key({input: 'q'}), mode)).toBe('quit');
    }
  });

  test('escape still goes back from the detail view rather than quitting', () => {
    expect(intentFor(key({escape: true}), 'detail')).toBe('back');
  });

  test('switching lists works from anywhere you can see one', () => {
    for (const mode of ['list', 'detail', 'projects'] as const) {
      expect(intentFor(key({input: '2'}), mode)).toBe('list-next');
    }
  });
});
