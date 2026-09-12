import {join} from 'node:path';
import {hasFlag} from '../core/args.ts';
import {diagnose, duplicatesToRemint, misfiledByMonth} from '../core/doctor.ts';
import {pluralize} from '../core/render.ts';
import {baseDirectories, taskDir} from '../core/state.ts';
import {sweepTempFiles} from '../store/write.ts';
import {EXIT_ERROR, EXIT_OK, describe, emit, loadWorld, type Command} from './context.ts';

export const DOCTOR_FLAGS = {boolean: ['fix'], alias: {f: 'fix'}} as const;

/** How old a temp file must be before it is assumed to be crash debris. */
const TEMP_FILE_GRACE_MS = 60 * 60 * 1000;

export const doctorCommand: Command = ctx => {
  const fix = hasFlag(ctx.args, 'fix');
  let snapshot = loadWorld(ctx);
  let repaired = 0;

  const swept = sweepTemps(ctx.dataDir, fix);
  if (fix) repaired += swept.length;

  if (fix) {
    // One lock for the whole repair pass, so nobody sees it half-done.
    repaired += ctx.store.batch(() => {
      let done = healFiles(ctx, snapshot);
      done += refileByMonth(ctx, ctx.store.load());
      done += remintDuplicates(ctx, ctx.store.load());
      return done;
    });
    ctx.store.invalidate();
    snapshot = ctx.store.load();
  }

  const remaining = diagnose(snapshot);

  emit(
    ctx,
    {
      ok: remaining.every(f => f.fixable),
      repaired,
      swept: swept.length,
      findings: remaining.map(f => ({
        kind: f.kind,
        message: f.message,
        path: f.path,
        fixable: f.fixable,
        remedy: f.remedy,
      })),
    },
    () => {
      const lines: string[] = [];
      if (swept.length > 0) {
        lines.push(
          fix
            ? `removed ${pluralize(swept.length, 'leftover temporary file')}`
            : `${pluralize(swept.length, 'leftover temporary file')} from an interrupted write`,
        );
      }
      if (repaired > 0) lines.push(`repaired ${pluralize(repaired, 'thing')}.`);
      if (remaining.length === 0) {
        lines.push(repaired > 0 ? 'Nothing else to report.' : 'Everything looks fine.');
        return lines;
      }
      lines.push('');
      for (const finding of remaining) {
        lines.push(`${finding.fixable ? 'fixable' : 'needs you'}  ${finding.message}`);
        if (!finding.fixable) lines.push(`           ${finding.remedy}`);
      }
      if (!fix && remaining.some(f => f.fixable)) {
        lines.push('');
        lines.push('run "omni doctor --fix" to repair what can be repaired safely');
      }
      return lines;
    },
  );

  // Something only a person can decide is the one thing worth a non-zero exit, so a
  // script can tell "all clear or tidied up" from "needs a human".
  return remaining.some(finding => !finding.fixable) ? EXIT_ERROR : EXIT_OK;
};

function sweepTemps(dataDir: string, fix: boolean): string[] {
  const now = Date.now();
  const dirs = [
    ...baseDirectories().map(relative => join(dataDir, relative)),
    dataDir,
  ];

  const found: string[] = [];
  for (const dir of dirs) {
    // With no --fix, a zero-age cutoff in the future would delete live temp files, so
    // the sweep only ever runs for real when asked.
    if (fix) found.push(...sweepTempFiles(dir, TEMP_FILE_GRACE_MS, now));
  }
  return found;
}

function healFiles(ctx: Parameters<Command>[0], snapshot: ReturnType<typeof loadWorld>): number {
  let healed = 0;
  for (const file of snapshot.needHealing) {
    // A file whose only complaint is a defer in the wrong place is not something to
    // rewrite; that needs a decision about intent.
    const actionable = file.task.repairs.some(
      r => r.kind !== 'defer-outside-someday' && r.kind !== 'done-month-mismatch',
    );
    if (!actionable) continue;
    try {
      ctx.store.heal(file);
      healed += 1;
    } catch (error) {
      if (!ctx.json) ctx.err(`could not heal ${file.stem}: ${describe(error)}`);
    }
  }

  for (const file of snapshot.projectsNeedHealing) {
    // A missing outcome is not something to invent, so a project whose only complaint
    // is that is left for a person to answer.
    const actionable = file.project.repairs.some(
      r => r.kind !== 'missing-outcome' && r.kind !== 'done-month-mismatch',
    );
    if (!actionable) continue;
    try {
      ctx.store.healProject(file);
      healed += 1;
    } catch (error) {
      if (!ctx.json) ctx.err(`could not heal ${file.stem}: ${describe(error)}`);
    }
  }

  return healed;
}

function refileByMonth(ctx: Parameters<Command>[0], snapshot: ReturnType<typeof loadWorld>): number {
  let moved = 0;
  for (const {file} of misfiledByMonth(snapshot)) {
    try {
      // Re-applying the task is enough: the store files it by its own done date.
      ctx.store.apply(file, {...file.task, repairs: []});
      moved += 1;
    } catch (error) {
      if (!ctx.json) ctx.err(`could not refile ${file.stem}: ${describe(error)}`);
    }
  }
  return moved;
}

function remintDuplicates(
  ctx: Parameters<Command>[0],
  snapshot: ReturnType<typeof loadWorld>,
): number {
  let reminted = 0;
  for (const file of duplicatesToRemint(snapshot)) {
    try {
      const id = ctx.store.mintId();
      ctx.store.apply(file, {...file.task, id, repairs: []});
      if (!ctx.json) ctx.err(`re-minted ${file.stem}: ${file.task.id} -> ${id}`);
      reminted += 1;
    } catch (error) {
      if (!ctx.json) ctx.err(`could not re-mint ${file.stem}: ${describe(error)}`);
    }
  }
  return reminted;
}

/** Exported for the tests, which assert on where a completed task should live. */
export function expectedDoneDir(dataDir: string, doneIso: string): string {
  return join(dataDir, taskDir('done', doneIso));
}
