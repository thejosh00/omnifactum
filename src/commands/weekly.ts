/**
 * `omni weekly` — the GTD weekly review.
 *
 * Named `weekly` rather than `review` because `omni review` already lists the work an
 * agent has finished and handed back. Two different things called review would be worse
 * than one slightly unusual verb.
 *
 * Non-interactive on purpose. It prints what each list would ask you, so it works in a
 * script, in a cron job, or as something an agent can read and act on. The guided walk
 * lives in the web app, where acting on what you find is a keypress away.
 */
import {hasFlag} from '../core/args.ts';
import {pluralize} from '../core/render.ts';
import type {ReviewPlan} from '../core/review.ts';
import {planToJson, recordWeekly, weeklyState} from '../db/weekly.ts';
import {EXIT_OK, emit, loadWorld, type Command, type CommandContext} from './context.ts';
import {runWrite} from './modify.ts';

export const WEEKLY_FLAGS = {boolean: ['record'], alias: {r: 'record'}} as const;

export const weeklyCommand: Command = ctx => {
  // Let deferred tasks surface first, so the review sees next as it really is.
  loadWorld(ctx);

  if (hasFlag(ctx.args, 'record')) {
    return runWrite(ctx, () => record(ctx));
  }

  const state = weeklyState(ctx.store, ctx.now());
  emit(ctx, planToJson(state), () => render(state.plan, state.daysSince));
  return EXIT_OK;
};

function render(plan: ReviewPlan, since: number | undefined): string[] {
  const lines: string[] = [];

  lines.push(
    since === undefined
      ? 'Weekly review. No previous pass recorded.'
      : `Weekly review. Last pass ${since === 0 ? 'today' : `${pluralize(since, 'day')} ago`}.`,
  );
  lines.push('');

  plan.steps.forEach((step, index) => {
    const clear = step.flags.length === 0;
    lines.push(`${index + 1}. ${step.title}  (${step.count})${clear ? '   — clear' : ''}`);
    lines.push(`   ${step.prompt}`);
    for (const flag of step.flags) lines.push(`   · ${flag.text}`);
    lines.push('');
  });

  lines.push(
    plan.needingAttention === 0
      ? 'Nothing needs attention. Run "omni weekly --record" to log the pass.'
      : `${pluralize(plan.needingAttention, 'step')} need attention. Work through them, then run "omni weekly --record".`,
  );

  return lines;
}

function record(ctx: CommandContext): number {
  const {plan, stamped} = recordWeekly(ctx.store, ctx.now());
  return emit(
    ctx,
    {ok: true, at: plan.at, projects_stamped: stamped, needs_attention: plan.needingAttention},
    () => [
      'recorded the review',
      stamped > 0 ? `stamped ${pluralize(stamped, 'project')} as reviewed` : 'no active projects to stamp',
    ],
  );
}
