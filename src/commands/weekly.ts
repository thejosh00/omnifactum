/**
 * `omni weekly` — the GTD weekly review.
 *
 * Named `weekly` rather than `review` because `omni review` already lists the work an
 * agent has finished and handed back. Two different things called review would be worse
 * than one slightly unusual verb.
 *
 * Non-interactive on purpose. It prints what each list would ask you, so it works in a
 * script, in a cron job, or as something an agent can read and act on. The guided walk
 * lives in the interactive interface, where acting on what you find is a keypress away.
 */
import {existsSync, readFileSync} from 'node:fs';
import {join} from 'node:path';
import {hasFlag} from '../core/args.ts';
import {planReviewed} from '../core/project.ts';
import {appendToLog, buildReview, daysSinceLastReview, summarize} from '../core/review.ts';
import {pluralize} from '../core/render.ts';
import {REVIEW_FILE} from '../store/paths.ts';
import type {ReviewPlan} from '../core/review.ts';
import {
  EXIT_ERROR,
  EXIT_OK,
  emit,
  fail,
  loadWorld,
  type Command,
  type CommandContext,
} from './context.ts';
import {runWrite} from './modify.ts';

export const WEEKLY_FLAGS = {boolean: ['record'], alias: {r: 'record'}} as const;

export const weeklyCommand: Command = ctx => {
  const snapshot = loadWorld(ctx);
  const plan = buildReview(snapshot, ctx.now());

  const log = readLog(ctx);
  const since = daysSinceLastReview(log, ctx.now());

  if (hasFlag(ctx.args, 'record')) {
    return runWrite(ctx, () => record(ctx, plan, log));
  }

  emit(
    ctx,
    {
      at: plan.at,
      days_since_last_review: since,
      needs_attention: plan.needingAttention,
      steps: plan.steps.map(step => ({
        step: step.kind,
        title: step.title,
        prompt: step.prompt,
        count: step.count,
        flags: step.flags,
      })),
    },
    () => render(plan, since),
  );

  return EXIT_OK;
};

function readLog(ctx: CommandContext): string | undefined {
  const path = join(ctx.dataDir, REVIEW_FILE);
  return existsSync(path) ? readFileSync(path, 'utf8') : undefined;
}

function render(plan: ReviewPlan, since: number | undefined): string[] {
  const lines: string[] = [];

  lines.push(
    since === undefined
      ? 'Weekly review. No previous pass recorded.'
      : `Weekly review. Last pass ${since === 0 ? 'today' : pluralize(since, 'day')} ago.`,
  );
  lines.push('');

  plan.steps.forEach((step, index) => {
    const clear = step.flags.length === 0;
    lines.push(`${index + 1}. ${step.title}  (${step.count})${clear ? '   — clear' : ''}`);
    lines.push(`   ${step.prompt}`);
    for (const flag of step.flags) lines.push(`   · ${flag}`);
    lines.push('');
  });

  lines.push(
    plan.needingAttention === 0
      ? 'Nothing needs attention. Run "omni weekly --record" to log the pass.'
      : `${pluralize(plan.needingAttention, 'step')} need attention. Work through them, then run "omni weekly --record".`,
  );

  return lines;
}

/**
 * Finish a pass: note the date on every active project and append to the log.
 *
 * Stamping the projects is what makes "which of these have I not looked at in a month"
 * answerable later, which is the question the weekly review exists to stop you needing
 * to ask.
 */
function record(ctx: CommandContext, plan: ReviewPlan, log: string | undefined): number {
  let stamped = 0;

  const outcome = ctx.store.batch(() => {
    const snapshot = ctx.store.load();
    for (const entry of snapshot.membership.projects) {
      if (entry.project.project.state !== 'active') continue;
      const result = ctx.store.updateProject(entry.project.project.id, project =>
        planReviewed(project, ctx.now()),
      );
      if (result.kind === 'ok') stamped += 1;
    }

    try {
      ctx.store.writeDocument(REVIEW_FILE, appendToLog(log, summarize(plan)));
      return undefined;
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  });

  if (outcome !== undefined) {
    return fail(ctx, `could not write ${REVIEW_FILE}: ${outcome}`, EXIT_ERROR);
  }

  return emit(
    ctx,
    {ok: true, at: plan.at, projects_stamped: stamped, needs_attention: plan.needingAttention},
    () => [
      `recorded the review in ${REVIEW_FILE}`,
      stamped > 0 ? `stamped ${pluralize(stamped, 'project')} as reviewed` : 'no active projects to stamp',
    ],
  );
}
