/**
 * The guided clarify flow, as a pure reducer.
 *
 * Clarifying is the step GTD actually turns on. Capture is easy and reviewing is a
 * habit, but an inbox only empties if there is a fixed set of questions you answer
 * without deciding which questions to ask. Processing items ad hoc — a move here, a tag
 * there — is how an inbox becomes a list you scroll past.
 *
 * The questions are the standard ones, cut down to what this app can act on:
 *
 *   1. Is it actionable?
 *   2. If not: keep it as someday/maybe, or drop it?
 *   3. If so: is it one action, or does it need several?
 *   4. Who does it — you, or someone else?
 *   5. What context does it belong to?
 *
 * Two questions GTD asks are deliberately absent. "Is it reference material?" has no
 * answer here, because there is no reference bucket and deletion is real; the
 * non-actionable branch therefore offers someday or an outright delete, and nothing
 * else. And "will it take two minutes?" is advice about when to stop clarifying, not a
 * place to file something — the app has no state for "already did it", and inventing one
 * to hold the answer would be worse than leaving the advice to the person.
 *
 * Everything here is values in and values out. The reducer never sees a task, a file or
 * a clock: it collects answers and reports an outcome, and `applyClarify` turns that
 * outcome into a task using the planners that already exist. That is what lets the whole
 * flow be tested — every branch, every answer, the back button — without rendering a
 * screen or writing a file.
 */
import {planMove, planSetTags, type ChangeContext} from './mutation.ts';
import {normalizeTags} from './tags.ts';
import type {Task, TaskState} from './types.ts';

/** Where the walk currently is. `done` means the outcome is ready to apply. */
export type ClarifyStep =
  | 'actionable'
  | 'keep'
  | 'confirm-discard'
  | 'scope'
  | 'project'
  | 'owner'
  | 'who'
  | 'tags'
  | 'done';

/** One answer to a choice question, and the key that picks it. */
export interface ClarifyChoice {
  key: string;
  label: string;
  /** What `answerClarify` is given when this is picked. */
  answer: string;
}

export interface ClarifyQuestion {
  step: ClarifyStep;
  /** The question itself, in the second person. */
  prompt: string;
  /** A sentence of help, for the questions where the wrong reading is common. */
  hint?: string;
  /** The options, for a question answered by choosing. Empty when it takes text. */
  choices: ClarifyChoice[];
  /** The placeholder for a question answered by typing. Absent for a choice. */
  placeholder?: string;
}

/**
 * Every question, as data.
 *
 * The screen renders this and the tests iterate it, the same arrangement the keymap
 * uses, so a question cannot exist without being answerable or be answerable without
 * being shown.
 */
export const CLARIFY_QUESTIONS: Record<Exclude<ClarifyStep, 'done'>, ClarifyQuestion> = {
  actionable: {
    step: 'actionable',
    prompt: 'Is there anything to do about this?',
    choices: [
      {key: 'y', label: 'yes, something has to happen', answer: 'yes'},
      {key: 'n', label: 'no, nothing has to happen', answer: 'no'},
    ],
  },
  keep: {
    step: 'keep',
    prompt: 'Nothing to do, then. Keep it or drop it?',
    hint: 'There is no reference bucket and no trash: dropping it is permanent.',
    choices: [
      {key: 's', label: 'keep it on someday/maybe', answer: 'someday'},
      {key: 'd', label: 'drop it', answer: 'drop'},
    ],
  },
  'confirm-discard': {
    step: 'confirm-discard',
    prompt: 'Delete it permanently? There is no undo.',
    choices: [
      {key: 'y', label: 'delete it', answer: 'yes'},
      {key: 'n', label: 'no, keep it after all', answer: 'no'},
    ],
  },
  scope: {
    step: 'scope',
    prompt: 'Is this one action, or does it take several?',
    hint: 'Several means it belongs to a project, and this is the next step of one.',
    choices: [
      {key: '1', label: 'one action', answer: 'one'},
      {key: 'p', label: 'part of a project', answer: 'project'},
    ],
  },
  project: {
    step: 'project',
    prompt: 'Which project?',
    hint: 'A name that does not exist yet is kept, and shows up as a dangling link.',
    choices: [],
    placeholder: 'project name or stem  (enter to leave it unlinked)',
  },
  owner: {
    step: 'owner',
    prompt: 'Who does it?',
    choices: [
      {key: 'm', label: 'me', answer: 'me'},
      {key: 'd', label: 'someone else', answer: 'delegate'},
    ],
  },
  who: {
    step: 'who',
    prompt: 'Who are you waiting on?',
    choices: [],
    placeholder: 'a name  (enter to skip)',
  },
  tags: {
    step: 'tags',
    prompt: 'Where can it be done?',
    hint: 'The context you would be in when you look for it: home, calls, errands.',
    choices: [],
    placeholder: 'tags, space separated  (enter for none)',
  },
};

/** What the walk decided to do with the item. */
export type ClarifyOutcome =
  | {kind: 'discard'}
  | {
      kind: 'file';
      state: TaskState;
      tags: string[];
      project?: string;
      waitingOn?: string;
    };

/** The answers collected so far. Kept so `back` can rewind without losing them. */
export interface ClarifyAnswers {
  actionable?: boolean;
  scope?: 'one' | 'project';
  project?: string;
  owner?: 'me' | 'delegate';
  who?: string;
  tags?: string[];
}

export interface ClarifySession {
  /**
   * The task being clarified, by id rather than by value. The walk takes several
   * keystrokes and an agent may change the task during it, so the id is the only part
   * worth holding on to; everything else is re-read when the outcome is applied.
   */
  taskId: string;
  step: ClarifyStep;
  answers: ClarifyAnswers;
  /** Set exactly when `step` is 'done'. */
  outcome?: ClarifyOutcome;
  /** Earlier positions, newest first, so a mis-keyed answer costs one keystroke. */
  history: Array<{step: ClarifyStep; answers: ClarifyAnswers}>;
}

export function startClarify(taskId: string): ClarifySession {
  return {taskId, step: 'actionable', answers: {}, history: []};
}

/** The question being asked, or undefined once the walk is over. */
export function currentQuestion(session: ClarifySession): ClarifyQuestion | undefined {
  return session.step === 'done' ? undefined : CLARIFY_QUESTIONS[session.step];
}

/**
 * Answer the current question.
 *
 * An answer a choice question does not recognise leaves the session exactly as it was,
 * so a stray keypress during the walk does nothing rather than something arbitrary.
 */
export function answerClarify(session: ClarifySession, answer: string): ClarifySession {
  const question = currentQuestion(session);
  if (question === undefined) return session;

  const value = answer.trim();
  if (question.choices.length > 0 && !question.choices.some(choice => choice.answer === value)) {
    return session;
  }

  const previous = {step: session.step, answers: session.answers};
  const advance = (answers: ClarifyAnswers, step: ClarifyStep): ClarifySession =>
    settle({
      ...session,
      answers,
      step,
      history: [previous, ...session.history],
    });

  switch (session.step) {
    case 'actionable':
      return value === 'yes'
        ? advance({...session.answers, actionable: true}, 'scope')
        : advance({...session.answers, actionable: false}, 'keep');

    case 'keep':
      return value === 'someday'
        ? advance(session.answers, 'done')
        : advance(session.answers, 'confirm-discard');

    case 'confirm-discard':
      // "No" goes back to the question rather than out of the walk: changing your mind
      // about deleting something is not a reason to start over.
      return value === 'yes' ? advance(session.answers, 'done') : advance(session.answers, 'keep');

    case 'scope':
      return value === 'one'
        ? advance({...session.answers, scope: 'one'}, 'owner')
        : advance({...session.answers, scope: 'project'}, 'project');

    case 'project': {
      const answers =
        value.length === 0 ? session.answers : {...session.answers, project: value};
      return advance(answers, 'owner');
    }

    case 'owner':
      return value === 'me'
        ? advance({...session.answers, owner: 'me'}, 'tags')
        : advance({...session.answers, owner: 'delegate'}, 'who');

    case 'who': {
      const answers = value.length === 0 ? session.answers : {...session.answers, who: value};
      return advance(answers, 'tags');
    }

    case 'tags':
      return advance({...session.answers, tags: normalizeTags(value.split(/\s+/)).tags}, 'done');

    default:
      return session;
  }
}

/** Undo the last answer. At the first question this is a no-op, not an exit. */
export function backClarify(session: ClarifySession): ClarifySession {
  const [previous, ...rest] = session.history;
  if (previous === undefined) return session;
  const {outcome: _outcome, ...withoutOutcome} = session;
  return {...withoutOutcome, step: previous.step, answers: previous.answers, history: rest};
}

/** Attach the outcome once the walk reaches the end. */
function settle(session: ClarifySession): ClarifySession {
  if (session.step !== 'done') return session;
  return {...session, outcome: outcomeOf(session.answers, session.history)};
}

function outcomeOf(
  answers: ClarifyAnswers,
  history: ClarifySession['history'],
): ClarifyOutcome {
  if (answers.actionable === false) {
    // Reached `done` from `confirm-discard` means the deletion was confirmed; reached
    // it from `keep` means someday was chosen.
    return history[0]?.step === 'confirm-discard' ? {kind: 'discard'} : {kind: 'file', state: 'someday', tags: []};
  }

  const outcome: ClarifyOutcome = {
    kind: 'file',
    state: answers.owner === 'delegate' ? 'waiting' : 'next',
    tags: answers.tags ?? [],
  };
  if (answers.project !== undefined) outcome.project = answers.project;
  if (answers.owner === 'delegate' && answers.who !== undefined) outcome.waitingOn = answers.who;
  return outcome;
}

/**
 * Turn an outcome into a task.
 *
 * Nothing new happens here: the tags go through `planSetTags` and the state through
 * `planMove`, which already knows that a delegation starts now and that `defer` has no
 * business outside someday. The clarify flow decides *what*, and the planners that
 * every other path uses decide *how*, so a task filed by the walk is indistinguishable
 * from one moved by hand.
 */
export function applyClarify(
  task: Task,
  outcome: ClarifyOutcome,
  ctx: ChangeContext,
): Task {
  if (outcome.kind === 'discard') {
    throw new Error('a discarded task is deleted, not written');
  }

  let next = planSetTags(task, outcome.tags);
  if (outcome.project !== undefined) next = {...next, project: outcome.project};
  // Set before the move, because `planMove` is what decides whether a delegation's
  // fields survive the destination.
  if (outcome.waitingOn !== undefined) next = {...next, waitingOn: outcome.waitingOn};

  return planMove(next, outcome.state, {...ctx, note: clarifyNote(outcome)});
}

/** What the log says about a clarified item, so the decision is readable later. */
export function clarifyNote(outcome: ClarifyOutcome): string {
  if (outcome.kind === 'discard') return 'Not actionable; dropped.';

  const parts: string[] = [];
  switch (outcome.state) {
    case 'someday':
      parts.push('Clarified: nothing to do now, kept as someday/maybe.');
      break;
    case 'waiting':
      parts.push(
        outcome.waitingOn === undefined
          ? 'Clarified: delegated.'
          : `Clarified: delegated to ${outcome.waitingOn}.`,
      );
      break;
    default:
      parts.push('Clarified: this is the next action.');
  }
  if (outcome.project !== undefined) parts.push(`Part of ${outcome.project}.`);
  return parts.join(' ');
}
