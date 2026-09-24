import {describe, expect, test} from 'bun:test';
import {describeChange, describeChanges, diffSnapshots} from '../../src/core/diff.ts';
import {buildSnapshot} from '../../src/core/snapshot.ts';
import type {LogEntry, TaskFile, TaskState} from '../../src/core/types.ts';

function entry(actor: string, text: string): LogEntry {
  return {at: '2026-09-12T11:03:00Z', actor, text, raw: '', parsed: true};
}

function file(
  id: string,
  state: TaskState,
  options: {title?: string; log?: LogEntry[]; version?: number} = {},
): TaskFile {
  return {
    task: {
      id,
      title: options.title ?? id,
      created: '2026-09-01T09:00:00Z',
      state,
      tags: [],
      body: '',
      log: options.log ?? [],
      repairs: [],
    },
    stem: id,
    version: options.version ?? 1,
  };
}

const snap = (files: TaskFile[]) => buildSnapshot(files, [], []);

describe('spotting what someone else did', () => {
  test('a task that moved to done was completed', () => {
    const before = snap([file('a', 'next', {title: 'Fix printer'})]);
    const after = snap([file('a', 'done', {title: 'Fix printer'})]);

    expect(diffSnapshots(before, after)).toEqual([
      {kind: 'completed', id: 'a', title: 'Fix printer', from: 'next', to: 'done'},
    ]);
  });

  test('a task that moved anywhere else just moved', () => {
    const before = snap([file('a', 'next')]);
    const after = snap([file('a', 'waiting')]);
    expect(diffSnapshots(before, after)[0]).toMatchObject({kind: 'moved', to: 'waiting'});
  });

  test('a task that appeared was added', () => {
    const before = snap([]);
    const after = snap([file('a', 'inbox', {title: 'Captured elsewhere'})]);
    expect(diffSnapshots(before, after)[0]).toMatchObject({kind: 'added', to: 'inbox'});
  });

  test('a task that vanished was deleted', () => {
    const before = snap([file('a', 'next', {title: 'Gone'})]);
    expect(diffSnapshots(before, snap([]))[0]).toMatchObject({kind: 'removed', title: 'Gone'});
  });

  test('a task rewritten in place was edited', () => {
    const before = snap([file('a', 'next', {version: 1})]);
    const after = snap([file('a', 'next', {version: 2})]);
    expect(diffSnapshots(before, after)[0]).toMatchObject({kind: 'edited'});
  });

  test('nothing changing is no change at all', () => {
    const files = [file('a', 'next'), file('b', 'inbox')];
    expect(diffSnapshots(snap(files), snap(files))).toEqual([]);
  });

  test('the actor and note come from the newest log entry', () => {
    const before = snap([file('a', 'next', {title: 'Fix printer'})]);
    const after = snap([
      file('a', 'done', {
        title: 'Fix printer',
        log: [entry('you', 'looked at it'), entry('agent:claude-code', 'Installed PPD 4.2.')],
      }),
    ]);

    expect(diffSnapshots(before, after)[0]).toMatchObject({
      actor: 'agent:claude-code',
      note: 'Installed PPD 4.2.',
    });
  });

  test('several changes are all reported', () => {
    const before = snap([file('a', 'next'), file('b', 'next')]);
    const after = snap([file('a', 'done'), file('b', 'waiting'), file('c', 'inbox')]);
    expect(diffSnapshots(before, after)).toHaveLength(3);
  });
});

describe('saying it in one line', () => {
  test('a completion names the task and who did it', () => {
    expect(
      describeChange({
        kind: 'completed',
        id: 'a',
        title: 'Fix printer',
        actor: 'agent:claude-code',
      }),
    ).toBe('"Fix printer" was completed by agent:claude-code');
  });

  test('your own change is not attributed back to you', () => {
    expect(describeChange({kind: 'completed', id: 'a', title: 'Fix printer', actor: 'you'})).toBe(
      '"Fix printer" was completed',
    );
  });

  test('an unattributed change simply says what happened', () => {
    expect(describeChange({kind: 'moved', id: 'a', title: 'Thing', to: 'waiting'})).toBe(
      '"Thing" moved to waiting',
    );
  });

  test('a single change includes the note, which is the interesting part', () => {
    expect(
      describeChanges([
        {
          kind: 'completed',
          id: 'a',
          title: 'Fix printer',
          actor: 'agent:claude-code',
          note: 'Installed PPD 4.2.',
        },
      ]),
    ).toBe('"Fix printer" was completed by agent:claude-code: Installed PPD 4.2.');
  });

  test('several completions are counted rather than listed', () => {
    expect(
      describeChanges([
        {kind: 'completed', id: 'a', title: 'A'},
        {kind: 'completed', id: 'b', title: 'B'},
      ]),
    ).toBe('2 tasks were completed elsewhere');
  });

  test('a mixed batch is counted too', () => {
    expect(
      describeChanges([
        {kind: 'completed', id: 'a', title: 'A'},
        {kind: 'added', id: 'b', title: 'B'},
      ]),
    ).toBe('2 tasks changed elsewhere');
  });

  test('no changes says nothing', () => {
    expect(describeChanges([])).toBeUndefined();
  });
});
