/**
 * The weekly review, as a pure plan.
 *
 * GTD's weekly review is a walk through every list, one at a time, asking a different
 * question of each. The walk is the point: it is the habit that stops the system
 * quietly rotting, and the reason a stalled project or a forgotten delegation gets
 * noticed at all.
 *
 * Everything here is derived from a snapshot and a clock, so what the review *says* is
 * an ordinary equality test. The interface only renders the result and lets the normal
 * keys act on it, which is why the review needed no new way to change a task.
 */
import {instantOf, isOverdue} from './tickler.ts';
import type {Snapshot} from './snapshot.ts';
import type {TaskFile} from './types.ts';
import type {ListName} from './view.ts';

/** How long a delegation can sit unchased before it is worth a second look. */
export const STALE_WAITING_DAYS = 7;

export type StepKind =
  | 'inbox'
  | 'review'
  | 'next'
  | 'waiting'
  | 'projects'
  | 'someday'
  | 'done';

export interface ReviewStep {
  kind: StepKind;
  title: string;
  /** The question this step asks. One line, in the second person. */
  prompt: string;
  /** Which list the interface should show while on this step. */
  list?: ListName;
  /** How many things are in scope here. */
  count: number;
  /**
   * Specific things worth acting on, as sentences. An empty list means this step is
   * clear and can be passed over quickly.
   */
  flags: string[];
}

export interface ReviewPlan {
  at: string;
  steps: ReviewStep[];
  /** Steps with something to act on. */
  needingAttention: number;
}

function daysBetween(fromIso: string, toIso: string): number | undefined {
  const from = instantOf(fromIso);
  const to = instantOf(toIso);
  if (from === undefined || to === undefined) return undefined;
  return Math.floor((to - from) / 86_400_000);
}

function tasksIn(snapshot: Snapshot, list: ListName): TaskFile[] {
  return snapshot.byState.get(list) ?? [];
}

export function buildReview(snapshot: Snapshot, nowIso: string): ReviewPlan {
  const steps: ReviewStep[] = [
    inboxStep(snapshot),
    reviewStep(snapshot),
    nextStep(snapshot, nowIso),
    waitingStep(snapshot, nowIso),
    projectsStep(snapshot),
    somedayStep(snapshot),
  ];

  return {
    at: nowIso,
    steps,
    needingAttention: steps.filter(step => step.flags.length > 0).length,
  };
}

function inboxStep(snapshot: Snapshot): ReviewStep {
  const items = tasksIn(snapshot, 'inbox');
  return {
    kind: 'inbox',
    title: 'Empty the inbox',
    prompt: 'For each: is it actionable? If so, what is the very next physical action?',
    list: 'inbox',
    count: items.length,
    flags:
      items.length === 0
        ? []
        : [`${items.length} item${items.length === 1 ? '' : 's'} still to be thought about`],
  };
}

function reviewStep(snapshot: Snapshot): ReviewStep {
  const items = tasksIn(snapshot, 'review');
  return {
    kind: 'review',
    title: 'Check finished work',
    prompt: 'Read what was done. Accept it, or send it back with a reason.',
    list: 'review',
    count: items.length,
    flags: items.map(file => {
      const last = [...file.task.log].reverse().find(entry => entry.parsed);
      const who = last?.actor !== undefined && last.actor.length > 0 ? ` (${last.actor})` : '';
      return `"${file.task.title}" is waiting on you${who}`;
    }),
  };
}

function nextStep(snapshot: Snapshot, nowIso: string): ReviewStep {
  const items = tasksIn(snapshot, 'next');
  const overdue = items.filter(file => isOverdue(file.task, nowIso));
  const untagged = items.filter(file => file.task.tags.length === 0);

  const flags: string[] = [];
  for (const file of overdue) flags.push(`"${file.task.title}" is past its due date`);
  if (untagged.length > 0) {
    // Not a fault, but an untagged action is one you will never find by context.
    flags.push(`${untagged.length} action${untagged.length === 1 ? ' has' : 's have'} no tags`);
  }

  return {
    kind: 'next',
    title: 'Review your next actions',
    prompt: 'Is each of these still the right next step, and still worth doing?',
    list: 'next',
    count: items.length,
    flags,
  };
}

function waitingStep(snapshot: Snapshot, nowIso: string): ReviewStep {
  const items = tasksIn(snapshot, 'waiting');

  const flags: string[] = [];
  for (const file of items) {
    const asked = file.task.asked;
    if (asked === undefined) continue;
    const days = daysBetween(asked, nowIso);
    if (days !== undefined && days >= STALE_WAITING_DAYS) {
      flags.push(`"${file.task.title}" has been waiting ${days} days — chase it?`);
    }
  }

  return {
    kind: 'waiting',
    title: 'Chase what others owe you',
    prompt: 'Has anything been waiting too long? Anything that quietly arrived already?',
    list: 'waiting',
    count: items.length,
    flags,
  };
}

function projectsStep(snapshot: Snapshot): ReviewStep {
  const entries = snapshot.membership.projects.filter(e => e.project.project.state === 'active');

  const flags: string[] = [];
  for (const entry of entries) {
    if (entry.stalled) {
      flags.push(`"${entry.project.project.title}" has no next action`);
    }
    if (entry.project.project.outcome.trim().length === 0) {
      flags.push(`"${entry.project.project.title}" has no outcome — what does done look like?`);
    }
  }
  for (const orphan of snapshot.membership.orphans) {
    flags.push(`"${orphan.file.task.title}" points at a project that does not exist`);
  }

  return {
    kind: 'projects',
    title: 'Check every project is moving',
    prompt: 'Does each active project have a next action, and a clear outcome?',
    count: entries.length,
    flags,
  };
}

function somedayStep(snapshot: Snapshot): ReviewStep {
  const items = tasksIn(snapshot, 'someday');
  return {
    kind: 'someday',
    title: 'Reconsider someday/maybe',
    prompt: 'Has anything here become worth doing? Has anything stopped being worth keeping?',
    list: 'someday',
    count: items.length,
    flags: [],
  };
}

/** The line written into REVIEW.md when a pass finishes. */
export function summarize(plan: ReviewPlan): string {
  const counts = plan.steps.map(step => `${step.kind} ${step.count}`).join(', ');
  const attention =
    plan.needingAttention === 0
      ? 'nothing needed attention'
      : `${plan.needingAttention} step${plan.needingAttention === 1 ? '' : 's'} needed attention`;
  return `- ${plan.at} — reviewed: ${counts}. ${attention}.`;
}

export const REVIEW_LOG_HEADING = '# Weekly reviews';

/** Append an entry to the review log, creating the document if it is not there yet. */
export function appendToLog(existing: string | undefined, entry: string): string {
  const body = (existing ?? '').trimEnd();
  if (body.length === 0) return `${REVIEW_LOG_HEADING}\n\n${entry}\n`;
  return `${body}\n${entry}\n`;
}

/** How long since the last recorded pass, for nudging. */
export function daysSinceLastReview(log: string | undefined, nowIso: string): number | undefined {
  if (log === undefined) return undefined;
  const stamps = [...log.matchAll(/^- (\S+) —/gm)].map(m => m[1]!);
  const latest = stamps[stamps.length - 1];
  if (latest === undefined) return undefined;
  return daysBetween(latest, nowIso);
}
