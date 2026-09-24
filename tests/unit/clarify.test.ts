/**
 * The guided clarify flow.
 *
 * Every branch is exercised here, with no screen and no filesystem, because the flow is
 * a reducer: what the walk *decides* is an ordinary equality test. The interface tests
 * only have to prove the keys reach it.
 */
import {describe, expect, test} from 'bun:test';
import {
  CLARIFY_QUESTIONS,
  answerClarify,
  applyClarify,
  backClarify,
  clarifyNote,
  currentQuestion,
  startClarify,
  type ClarifySession,
} from '../../src/core/clarify.ts';
import type {Task} from '../../src/core/types.ts';

const NOW = '2026-09-12T11:03:00Z';

/** Answer a run of questions in order, the way a person would type them. */
function walk(...answers: string[]): ClarifySession {
  return answers.reduce(answerClarify, startClarify('1nab5wap5x2q'));
}

function inboxTask(): Task {
  return {
    id: '1nab5wap5x2q',
    title: 'Something from the pile',
    created: '2026-09-12T10:04:00Z',
    state: 'inbox',
    tags: [],
    body: '',
    log: [],
    repairs: [],
  };
}

describe('the questions', () => {
  test('every one is either a choice or takes typed text, never both', () => {
    for (const question of Object.values(CLARIFY_QUESTIONS)) {
      const typed = question.placeholder !== undefined;
      expect({step: question.step, both: typed && question.choices.length > 0}).toEqual({
        step: question.step,
        both: false,
      });
      expect({step: question.step, neither: !typed && question.choices.length === 0}).toEqual({
        step: question.step,
        neither: false,
      });
    }
  });

  test('no two choices in one question share a key', () => {
    for (const question of Object.values(CLARIFY_QUESTIONS)) {
      const keys = question.choices.map(choice => choice.key);
      expect({step: question.step, keys: new Set(keys).size}).toEqual({
        step: question.step,
        keys: keys.length,
      });
    }
  });

  test('it opens by asking whether there is anything to do', () => {
    expect(currentQuestion(startClarify('x'))?.step).toBe('actionable');
  });
});

describe('the non-actionable branch', () => {
  test('offers only someday or deleting, because there is no reference bucket', () => {
    const session = walk('no');
    expect(session.step).toBe('keep');
    expect(currentQuestion(session)?.choices.map(c => c.answer)).toEqual(['someday', 'drop']);
  });

  test('someday files it there and asks nothing else', () => {
    const session = walk('no', 'someday');
    expect(session.step).toBe('done');
    expect(session.outcome).toEqual({kind: 'file', state: 'someday', tags: []});
  });

  test('dropping it asks again before anything is lost', () => {
    const session = walk('no', 'drop');
    expect(session.step).toBe('confirm-discard');
    expect(session.outcome).toBeUndefined();
  });

  test('confirming the drop is the only way to reach a discard', () => {
    expect(walk('no', 'drop', 'yes').outcome).toEqual({kind: 'discard'});
  });

  test('declining the drop returns to the question rather than ending the walk', () => {
    const session = walk('no', 'drop', 'no');
    expect(session.step).toBe('keep');
    expect(session.outcome).toBeUndefined();
    // And someday is still reachable from there.
    expect(answerClarify(session, 'someday').outcome).toEqual({
      kind: 'file',
      state: 'someday',
      tags: [],
    });
  });
});

describe('the actionable branch', () => {
  test('a single action you own lands in next with its tags', () => {
    const session = walk('yes', 'one', 'me', 'home calls');
    expect(session.step).toBe('done');
    expect(session.outcome).toEqual({kind: 'file', state: 'next', tags: ['home', 'calls']});
  });

  test('no tags is a valid answer, not a missing one', () => {
    expect(walk('yes', 'one', 'me', '').outcome).toEqual({
      kind: 'file',
      state: 'next',
      tags: [],
    });
  });

  test('part of a project asks which, then for the next step, and keeps both', () => {
    expect(walk('yes', 'project').step).toBe('project');
    expect(walk('yes', 'project', 'renovate-kitchen').step).toBe('next-step');
    expect(walk('yes', 'project', 'renovate-kitchen', 'Measure the walls', 'me', '').outcome).toEqual({
      kind: 'file',
      state: 'next',
      tags: [],
      project: 'renovate-kitchen',
      title: 'Measure the walls',
    });
  });

  test('the next step is required, because the captured text is the outcome', () => {
    const session = walk('yes', 'project', 'renovate-kitchen');
    expect(answerClarify(session, '  ')).toBe(session);
  });

  test('leaving the project blank skips the link but still asks for the next step', () => {
    const outcome = walk('yes', 'project', '', 'Call Sam', 'me', '').outcome;
    expect(outcome).toEqual({kind: 'file', state: 'next', tags: [], title: 'Call Sam'});
  });

  test('one action keeps its captured title', () => {
    expect(walk('yes', 'one', 'me', '').outcome).not.toHaveProperty('title');
  });

  test('someone else owning it asks who, and files it in waiting', () => {
    const session = walk('yes', 'one', 'delegate');
    expect(session.step).toBe('who');
    expect(walk('yes', 'one', 'delegate', 'Priya', 'work').outcome).toEqual({
      kind: 'file',
      state: 'waiting',
      tags: ['work'],
      waitingOn: 'Priya',
    });
  });

  test('a delegation with nobody named is still a delegation', () => {
    expect(walk('yes', 'one', 'delegate', '', '').outcome).toEqual({
      kind: 'file',
      state: 'waiting',
      tags: [],
    });
  });
});

describe('answers it does not understand', () => {
  test('leave the session exactly as it was', () => {
    const session = walk('yes');
    expect(answerClarify(session, 'maybe')).toBe(session);
    expect(answerClarify(session, '')).toBe(session);
  });

  test('a finished walk ignores further answers', () => {
    const done = walk('no', 'someday');
    expect(answerClarify(done, 'yes')).toBe(done);
  });
});

describe('going back', () => {
  test('undoes the last answer and re-asks it', () => {
    const session = backClarify(walk('yes', 'one'));
    expect(session.step).toBe('scope');
    expect(session.answers.owner).toBeUndefined();
  });

  test('at the first question it does nothing rather than leaving the walk', () => {
    const start = startClarify('x');
    expect(backClarify(start)).toBe(start);
  });

  test('clears an outcome that had already been reached', () => {
    const session = backClarify(walk('no', 'someday'));
    expect(session.step).toBe('keep');
    expect(session.outcome).toBeUndefined();
    expect('outcome' in session).toBe(false);
  });

  test('a different answer the second time produces a different outcome', () => {
    const changed = answerClarify(backClarify(walk('yes', 'one', 'me', '')), 'home');
    expect(changed.outcome).toEqual({kind: 'file', state: 'next', tags: ['home']});
  });
});

describe('applying an outcome', () => {
  test('moves the task, sets its tags, and says why in the log', () => {
    const outcome = walk('yes', 'one', 'me', 'home').outcome!;
    const task = applyClarify(inboxTask(), outcome, {nowIso: NOW});

    expect(task.state).toBe('next');
    expect(task.tags).toEqual(['home']);
    expect(task.log).toHaveLength(1);
    expect(task.log[0]!.text).toBe('Clarified: this is the next action.');
  });

  test('tags it already had are kept, and the answer adds to them', () => {
    const outcome = walk('yes', 'one', 'me', 'home').outcome!;
    const task = applyClarify({...inboxTask(), tags: ['calls', 'agent']}, outcome, {nowIso: NOW});
    expect([...task.tags].sort()).toEqual(['agent', 'calls', 'home']);
  });

  test('an empty tags answer, or filing to someday, strips nothing', () => {
    const captured = {...inboxTask(), tags: ['calls']};
    expect(applyClarify(captured, walk('yes', 'one', 'me', '').outcome!, {nowIso: NOW}).tags).toEqual(['calls']);
    expect(applyClarify(captured, walk('no', 'someday').outcome!, {nowIso: NOW}).tags).toEqual(['calls']);
  });

  test('a delegation records who, and when it was asked', () => {
    const outcome = walk('yes', 'one', 'delegate', 'Priya', '').outcome!;
    const task = applyClarify(inboxTask(), outcome, {nowIso: NOW});

    expect(task.state).toBe('waiting');
    expect(task.waitingOn).toBe('Priya');
    // Stamped by planMove, which is what makes the weekly review's chase check work.
    expect(task.asked).toBe(NOW);
    expect(task.log[0]!.text).toBe('Clarified: delegated to Priya.');
  });

  test('a project link survives the move and is named in the log', () => {
    const outcome = walk('yes', 'project', 'renovate-kitchen', 'Measure the walls', 'me', '').outcome!;
    const task = applyClarify(inboxTask(), outcome, {nowIso: NOW});

    expect(task.project).toBe('renovate-kitchen');
    expect(task.log[0]!.text).toContain('Part of renovate-kitchen.');
  });

  test('the next step becomes the title, and the captured text stays in the log', () => {
    const captured = inboxTask();
    const outcome = walk('yes', 'project', 'renovate-kitchen', 'Measure the walls', 'me', '').outcome!;
    const task = applyClarify(captured, outcome, {nowIso: NOW});

    expect(task.title).toBe('Measure the walls');
    expect(task.log.at(-1)!.text).toContain(`Captured as "${captured.title}".`);
  });

  test('someday keeps nothing that belongs to another state', () => {
    const outcome = walk('no', 'someday').outcome!;
    const task = applyClarify({...inboxTask(), waitingOn: 'Priya'}, outcome, {nowIso: NOW});

    expect(task.state).toBe('someday');
    expect(task.waitingOn).toBeUndefined();
  });

  test('the actor reaches the log', () => {
    const outcome = walk('yes', 'one', 'me', '').outcome!;
    const task = applyClarify(inboxTask(), outcome, {nowIso: NOW, actor: 'agent:tidy'});
    expect(task.log[0]!.actor).toBe('agent:tidy');
  });

  test('a discard is a deletion, so writing one is refused outright', () => {
    expect(() => applyClarify(inboxTask(), {kind: 'discard'}, {nowIso: NOW})).toThrow();
  });

  test('the note for a discard still reads sensibly, for whoever reports it', () => {
    expect(clarifyNote({kind: 'discard'})).toBe('Not actionable; dropped.');
  });
});
