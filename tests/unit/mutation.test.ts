/**
 * The planners, as pure values.
 *
 * These cover the fields a state owns rather than the round trip through a file, which
 * `tests/store` already exercises. The delegation fields matter most: `waiting_on` and
 * `asked` only mean anything in `waiting/`, and `asked` is what the weekly review's one
 * proactive check reads.
 */
import {describe, expect, test} from 'bun:test';
import {planMove, planNewTask, planNote, planSubmit} from '../../src/core/mutation.ts';
import type {Task} from '../../src/core/types.ts';

const NOW = '2026-09-12T11:03:00Z';
const EARLIER = '2026-09-01T09:00:00Z';

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: '1nab5wap5x2q',
    title: 'Get the quote back from the builder',
    created: '2026-08-30T10:04:00Z',
    state: 'next',
    tags: [],
    body: '',
    log: [],
    repairs: [],
    ...overrides,
  };
}

describe('when a delegation starts', () => {
  test('moving into waiting stamps asked', () => {
    expect(planMove(task(), 'waiting', {nowIso: NOW}).asked).toBe(NOW);
  });

  test('a task created in waiting is stamped too', () => {
    const created = planNewTask({
      id: 'x',
      title: 'Quote from the builder',
      state: 'waiting',
      waitingOn: 'Sam',
      nowIso: NOW,
    });
    expect(created.asked).toBe(NOW);
    expect(created.waitingOn).toBe('Sam');
  });

  test('an explicit date wins over the clock, for importing history', () => {
    const created = planNewTask({
      id: 'x',
      title: 'Quote from the builder',
      state: 'waiting',
      asked: EARLIER,
      nowIso: NOW,
    });
    expect(created.asked).toBe(EARLIER);
  });

  test('nothing else gets stamped, because nothing else is a delegation', () => {
    for (const state of ['inbox', 'next', 'someday'] as const) {
      expect({state, asked: planMove(task(), state, {nowIso: NOW}).asked}).toEqual({
        state,
        asked: undefined,
      });
      const created = planNewTask({id: 'x', title: 'A thing', state, nowIso: NOW});
      expect({state, created: created.asked}).toEqual({state, created: undefined});
    }
  });
});

describe('when a delegation does not restart', () => {
  test('a date already on the task survives a move within waiting', () => {
    const waiting = task({state: 'waiting', waitingOn: 'Sam', asked: EARLIER});
    // Re-filing it, or editing it and moving it back, is not asking again.
    expect(planMove(waiting, 'waiting', {nowIso: NOW}).asked).toBe(EARLIER);
  });

  test('but leaving waiting drops it, along with who you were waiting on', () => {
    const waiting = task({state: 'waiting', waitingOn: 'Sam', asked: EARLIER});
    const moved = planMove(waiting, 'next', {nowIso: NOW});
    expect(moved.asked).toBeUndefined();
    expect(moved.waitingOn).toBeUndefined();
  });

  test('and coming back later is a new delegation, stamped now', () => {
    const waiting = task({state: 'waiting', waitingOn: 'Sam', asked: EARLIER});
    const round = planMove(planMove(waiting, 'next', {nowIso: EARLIER}), 'waiting', {nowIso: NOW});
    expect(round.asked).toBe(NOW);
  });

  test('submitting for review ends the delegation, as it always did', () => {
    const waiting = task({state: 'waiting', waitingOn: 'Sam', asked: EARLIER});
    const submitted = planSubmit(waiting, {nowIso: NOW, note: 'Chased and got it.'});
    expect(submitted.asked).toBeUndefined();
    expect(submitted.waitingOn).toBeUndefined();
  });
});

describe('a note on its own', () => {
  test('adds a log line and changes nothing else', () => {
    const before = task({tags: ['work']});
    const after = planNote(before, {nowIso: NOW, actor: 'agent:claude-code', note: 'Chased Sam.'});

    expect(after.log).toHaveLength(1);
    expect(after.log[0]).toMatchObject({at: NOW, actor: 'agent:claude-code', text: 'Chased Sam.'});
    expect({...after, log: []}).toEqual({...before, log: []});
  });
});
