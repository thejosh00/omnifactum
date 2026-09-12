import {describe, expect, test} from 'bun:test';
import {buildSnapshot} from '../../src/core/snapshot.ts';
import {
  indexOfSelection,
  initialView,
  moveSelection,
  reconcileSelection,
  selectLast,
  selectedTask,
  visibleTasks,
  windowRange,
} from '../../src/core/view.ts';
import type {View} from '../../src/core/view.ts';
import type {TaskFile, TaskState} from '../../src/core/types.ts';

const NOW = '2026-09-12T11:03:00Z';

function file(
  id: string,
  state: TaskState,
  extra: {tags?: string[]; title?: string; defer?: string} = {},
): TaskFile {
  return {
    task: {
      id,
      title: extra.title ?? id,
      created: '2026-09-01T09:00:00Z',
      state,
      tags: extra.tags ?? [],
      body: '',
      log: [],
      repairs: [],
      ...(extra.defer === undefined ? {} : {defer: extra.defer}),
    },
    path: `/${state}/${id}.md`,
    stem: id,
    mtimeMs: 0,
    size: 0,
    raw: '',
  };
}

const snapshotOf = (files: TaskFile[]) => buildSnapshot(files, [], []);
const view = (overrides: Partial<View> = {}): View => ({...initialView(), ...overrides});

describe('which rows are visible', () => {
  const snapshot = snapshotOf([
    file('a', 'next', {tags: ['home']}),
    file('b', 'next', {tags: ['work']}),
    file('c', 'inbox'),
  ]);

  test('only the chosen list', () => {
    expect(visibleTasks(snapshot, view({list: 'next'}), NOW).map(f => f.task.id)).toEqual(['a', 'b']);
    expect(visibleTasks(snapshot, view({list: 'inbox'}), NOW).map(f => f.task.id)).toEqual(['c']);
  });

  test('narrowed by the same query language as the command line', () => {
    expect(visibleTasks(snapshot, view({list: 'next', query: 'home'}), NOW).map(f => f.task.id)).toEqual(['a']);
    expect(visibleTasks(snapshot, view({list: 'next', query: '-home'}), NOW).map(f => f.task.id)).toEqual(['b']);
  });

  test('an empty list is empty rather than an error', () => {
    expect(visibleTasks(snapshotOf([]), view(), NOW)).toEqual([]);
  });

  test('deferred tasks stay hidden until asked for', () => {
    const deferred = snapshotOf([file('later', 'someday', {defer: '2027-01-01'})]);
    expect(visibleTasks(deferred, view({list: 'someday'}), NOW)).toEqual([]);
    expect(
      visibleTasks(deferred, view({list: 'someday', showDeferred: true}), NOW),
    ).toHaveLength(1);
  });

  test('completed tasks read newest first', () => {
    const done = snapshotOf([file('older', 'done'), file('newer', 'done')]);
    expect(visibleTasks(done, view({list: 'done'}), NOW).map(f => f.task.id)).toEqual([
      'newer',
      'older',
    ]);
  });
});

describe('the cursor', () => {
  const rows = [file('a', 'next'), file('b', 'next'), file('c', 'next')];

  test('defaults to the first row', () => {
    expect(indexOfSelection(rows, undefined)).toBe(0);
    expect(selectedTask(rows, undefined)?.task.id).toBe('a');
  });

  test('moves by id, not by index', () => {
    expect(moveSelection(rows, 'a', 1)).toBe('b');
    expect(moveSelection(rows, 'b', -1)).toBe('a');
  });

  test('clamps at both ends rather than wrapping', () => {
    expect(moveSelection(rows, 'a', -1)).toBe('a');
    expect(moveSelection(rows, 'c', 1)).toBe('c');
    expect(moveSelection(rows, 'a', 99)).toBe('c');
  });

  test('has nothing to select in an empty list', () => {
    expect(moveSelection([], undefined, 1)).toBeUndefined();
    expect(indexOfSelection([], undefined)).toBe(-1);
    expect(selectLast([])).toBeUndefined();
  });

  test('a selection that no longer exists falls back to the first row', () => {
    expect(indexOfSelection(rows, 'gone')).toBe(0);
  });
});

describe('keeping the cursor sensible when the list is rebuilt', () => {
  const before = [file('a', 'next'), file('b', 'next'), file('c', 'next')];

  test('an untouched selection stays put', () => {
    expect(reconcileSelection(before, before, 'b')).toBe('b');
  });

  // The case that matters: an agent completes the task you are sitting on.
  test('a vanished selection lands on what took its place', () => {
    const after = [file('a', 'next'), file('c', 'next')];
    expect(reconcileSelection(after, before, 'b')).toBe('c');
  });

  test('a vanished last row lands on the new last row', () => {
    const after = [file('a', 'next'), file('b', 'next')];
    expect(reconcileSelection(after, before, 'c')).toBe('b');
  });

  test('an emptied list selects nothing', () => {
    expect(reconcileSelection([], before, 'b')).toBeUndefined();
  });

  test('a selection that was never in the list starts at the top', () => {
    expect(reconcileSelection(before, before, 'never-here')).toBe('a');
  });
});

describe('windowing, which Ink needs because it has no virtualization', () => {
  test('a short list is shown whole', () => {
    expect(windowRange(3, 0, 10)).toEqual({start: 0, end: 3});
  });

  test('a long list is clipped to the height', () => {
    const {start, end} = windowRange(100, 0, 10);
    expect(end - start).toBe(10);
  });

  test('the cursor is always inside the window', () => {
    for (const selected of [0, 1, 7, 50, 98, 99]) {
      const {start, end} = windowRange(100, selected, 10);
      expect(selected).toBeGreaterThanOrEqual(start);
      expect(selected).toBeLessThan(end);
    }
  });

  test('the window never runs past either end', () => {
    expect(windowRange(100, 99, 10).end).toBe(100);
    expect(windowRange(100, 0, 10).start).toBe(0);
  });

  test('a one-row viewport still works', () => {
    expect(windowRange(100, 42, 1)).toEqual({start: 42, end: 43});
  });

  test('a zero height is treated as one row rather than crashing', () => {
    expect(windowRange(10, 5, 0)).toEqual({start: 5, end: 6});
  });

  test('an empty list windows to nothing', () => {
    expect(windowRange(0, 0, 10)).toEqual({start: 0, end: 0});
  });
});
