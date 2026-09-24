/**
 * The weekly review against a store: what it says now, and recording a pass.
 *
 * Shared by `omni weekly` and the web app's walk, so the two can never disagree about
 * what needs attention or what finishing a pass does.
 */
import {planReviewed} from '../core/project.ts';
import {appendToLog, buildReview, daysSinceLastReview, summarize, type ReviewPlan} from '../core/review.ts';
import type {Store} from './store.ts';

/** The review log, kept per account as a document. */
export const REVIEW_LOG = 'REVIEW.md';

export interface WeeklyState {
  plan: ReviewPlan;
  /** Days since the last recorded pass, or undefined if there has never been one. */
  daysSince: number | undefined;
}

export function weeklyState(store: Store, nowIso: string): WeeklyState {
  return {
    plan: buildReview(store.load(), nowIso),
    daysSince: daysSinceLastReview(store.readDocument(REVIEW_LOG), nowIso),
  };
}

export interface Recorded {
  plan: ReviewPlan;
  /** Active projects stamped as reviewed today. */
  stamped: number;
}

/**
 * Finish a pass: note the date on every active project and append to the log, in one
 * transaction.
 *
 * Stamping the projects is what makes "which of these have I not looked at in a month"
 * answerable later, which is the question the weekly review exists to stop you needing
 * to ask. The plan is rebuilt here rather than taken from the caller, so the log records
 * how things stood when the pass was finished, not when it was started.
 */
export function recordWeekly(store: Store, nowIso: string): Recorded {
  return store.batch(() => {
    const snapshot = store.load();
    const plan = buildReview(snapshot, nowIso);
    let stamped = 0;
    for (const entry of snapshot.membership.projects) {
      if (entry.project.project.state !== 'active') continue;
      const result = store.updateProject(entry.project.project.id, project => planReviewed(project, nowIso));
      if (result.kind === 'ok') stamped += 1;
    }
    store.writeDocument(REVIEW_LOG, appendToLog(store.readDocument(REVIEW_LOG), summarize(plan)));
    return {plan, stamped};
  });
}

/** The plan as JSON. `flags` stay sentences, as they always were; `flag_tasks` says which task each is about. */
export function planToJson(state: WeeklyState): Record<string, unknown> {
  const {plan, daysSince} = state;
  return {
    at: plan.at,
    days_since_last_review: daysSince,
    needs_attention: plan.needingAttention,
    steps: plan.steps.map(step => ({
      step: step.kind,
      title: step.title,
      prompt: step.prompt,
      ...(step.list === undefined ? {} : {list: step.list}),
      count: step.count,
      flags: step.flags.map(flag => flag.text),
      flag_tasks: step.flags.map(flag => flag.taskId ?? null),
    })),
  };
}
