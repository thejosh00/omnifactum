import {describe, expect, test} from 'bun:test';
import {
  baseDirectories,
  doneMonth,
  isDoneMonth,
  projectDir,
  projectStateFromDir,
  taskDir,
  taskStateFromDir,
} from '../../src/core/state.ts';

describe('doneMonth is computed in UTC, deliberately', () => {
  test('bucket by month', () => {
    expect(doneMonth('2026-09-12T11:03:00Z')).toBe('2026-09');
  });

  // The sharp edge: an agent completing a task late on the last day of a month
  // would file it under the wrong month if local time were used.
  test('a late-night local completion still files by the UTC month', () => {
    expect(doneMonth('2026-09-30T23:50:00-07:00')).toBe('2026-10');
  });

  test('a timestamp already in UTC is taken at face value', () => {
    expect(doneMonth('2026-01-01T00:00:00Z')).toBe('2026-01');
  });

  test('rejects something that is not a timestamp', () => {
    expect(() => doneMonth('sometime last week')).toThrow();
  });
});

describe('isDoneMonth', () => {
  test('accepts a real month bucket', () => {
    expect(isDoneMonth('2026-09')).toBe(true);
    expect(isDoneMonth('2026-12')).toBe(true);
  });

  test('rejects anything else, so stray folders stay invisible', () => {
    for (const bad of ['2026-13', '2026-00', '2026', 'archive', '2026-9']) {
      expect(isDoneMonth(bad)).toBe(false);
    }
  });
});

describe('the directory a task belongs in', () => {
  test('is simply the state for everything but done', () => {
    expect(taskDir('inbox')).toBe('inbox');
    expect(taskDir('next')).toBe('next');
    expect(taskDir('waiting')).toBe('waiting');
    expect(taskDir('someday')).toBe('someday');
    // Review is a queue you drain, so it stays flat rather than bucketing by month.
    expect(taskDir('review')).toBe('review');
  });

  test('is a month bucket for done', () => {
    expect(taskDir('done', '2026-09-12T11:03:00Z')).toBe('done/2026-09');
  });

  test('refuses to file a completed task with no completion time', () => {
    expect(() => taskDir('done')).toThrow();
  });
});

describe('the directory a project belongs in', () => {
  test('nests under projects/', () => {
    expect(projectDir('active')).toBe('projects/active');
    expect(projectDir('someday')).toBe('projects/someday');
    expect(projectDir('done', '2026-08-04T09:00:00Z')).toBe('projects/done/2026-08');
  });
});

describe('reading state back out of a directory', () => {
  test('round-trips every task state', () => {
    for (const state of ['inbox', 'next', 'waiting', 'someday', 'review'] as const) {
      expect(taskStateFromDir(taskDir(state))).toEqual({state});
    }
    expect(taskStateFromDir('done/2026-09')).toEqual({state: 'done', month: '2026-09'});
  });

  test('ignores a directory the app does not recognise', () => {
    for (const dir of ['reference', 'trash', '.omni', 'archive', '']) {
      expect(taskStateFromDir(dir)).toBeUndefined();
    }
  });

  test('ignores nesting under a state, rather than adopting it', () => {
    expect(taskStateFromDir('next/subfolder')).toBeUndefined();
    expect(taskStateFromDir('done/2026-09/extra')).toBeUndefined();
  });

  test('ignores a done folder that is not a month', () => {
    expect(taskStateFromDir('done')).toBeUndefined();
    expect(taskStateFromDir('done/old')).toBeUndefined();
  });

  test('does not treat a project directory as a task directory', () => {
    expect(taskStateFromDir('projects/active')).toBeUndefined();
  });

  test('round-trips every project state', () => {
    expect(projectStateFromDir('projects/active')).toEqual({state: 'active'});
    expect(projectStateFromDir('projects/someday')).toEqual({state: 'someday'});
    expect(projectStateFromDir('projects/done/2026-08')).toEqual({
      state: 'done',
      month: '2026-08',
    });
  });

  test('does not treat a task directory as a project directory', () => {
    expect(projectStateFromDir('next')).toBeUndefined();
    expect(projectStateFromDir('projects')).toBeUndefined();
  });
});

describe('baseDirectories', () => {
  const dirs = baseDirectories();

  test('covers every state a file can be filed under', () => {
    expect(dirs).toEqual([
      'inbox',
      'next',
      'waiting',
      'someday',
      'review',
      'done',
      'projects/active',
      'projects/someday',
      'projects/done',
    ]);
  });
});
