/**
 * `omni project` — the first-class project entity.
 *
 * A project is an outcome that needs more than one action. It gets its own file so it
 * can carry the thing a tag cannot: a statement of what done looks like, and therefore
 * the ability to notice when nothing is moving it forward.
 */
import {readFileSync} from 'node:fs';
import {flagList, flagValue, hasFlag} from '../core/args.ts';
import {
  planCompleteProject,
  planMoveProject,
  planNewProject,
  planRenameProject,
  planSetOutcome,
  resolveProjectRef,
} from '../core/project.ts';
import {pluralize, shortId} from '../core/render.ts';
import {projectToJson, taskToJson} from '../core/serialize.ts';
import {membershipFor} from '../core/snapshot.ts';
import {stalledProjects} from '../core/stalled.ts';
import {isProjectState} from '../core/types.ts';
import type {ProjectMembership} from '../core/stalled.ts';
import type {Snapshot} from '../core/snapshot.ts';
import type {ProjectFile} from '../core/types.ts';
import {
  EXIT_ERROR,
  EXIT_NOT_FOUND,
  EXIT_USAGE,
  emit,
  emitOk,
  fail,
  loadWorld,
  type Command,
  type CommandContext,
} from './context.ts';
import {runWrite} from './modify.ts';

export const PROJECT_FLAGS = {
  boolean: ['stalled', 'all', 'yes', 'force'],
  alias: {o: 'outcome', t: 'tag', d: 'due', n: 'note', y: 'yes'},
} as const;

export const projectCommand: Command = ctx => {
  const [sub, ...rest] = ctx.args.positional;
  const inner: CommandContext = {...ctx, args: {...ctx.args, positional: rest}};

  switch (sub) {
    case undefined:
    case 'list':
    case 'ls':
      return listProjects(inner);
    case 'new':
    case 'add':
      return newProject(inner);
    case 'show':
      return showProject(inner);
    case 'rename':
      return renameProject(inner);
    case 'outcome':
      return setOutcome(inner);
    case 'done':
      return completeProject(inner);
    case 'mv':
    case 'move':
      return moveProject(inner);
    default:
      return fail(
        ctx,
        `omni project: "${sub}" is not a subcommand`,
        EXIT_USAGE,
        {hint: 'try: list, new, show, rename, outcome, done, mv'},
      );
  }
};

function toJson(entry: ProjectMembership): ReturnType<typeof projectToJson> {
  return projectToJson(entry.project, {liveActions: entry.live.length, stalled: entry.stalled});
}

function findProject(
  ctx: CommandContext,
  snapshot: Snapshot,
  ref: string,
): {file: ProjectFile} | {code: number} {
  const match = resolveProjectRef(snapshot.projects, ref);
  if (match.kind === 'ok') return {file: match.project};

  if (match.kind === 'ambiguous') {
    return {
      code: fail(ctx, `"${ref}" matches more than one project`, EXIT_NOT_FOUND, {
        candidates: match.candidates.map(f => `${f.stem}  ${f.project.title}`),
      }),
    };
  }
  return {code: fail(ctx, `no project matches "${ref}"`, EXIT_NOT_FOUND)};
}

/**
 * Resolve a project reference and change it, both inside one lock.
 *
 * The same rule `withTask` enforces for tasks, and it is not theoretical here either: a
 * project being completed is moved from `projects/active/` into `projects/done/YYYY-MM/`,
 * so a scan that has already walked the first directory and not yet reached the second
 * misses it entirely. Resolving outside the lock therefore fails to find a project that
 * certainly exists, and does it only under the concurrency the lock was added for.
 *
 * The snapshot the reference was resolved against is handed on, so a caller that also
 * needs the project's membership does not pay for a second scan.
 */
function withProject(
  ctx: CommandContext,
  ref: string,
  run: (file: ProjectFile, snapshot: Snapshot) => number,
): number {
  return ctx.store.batch(() => {
    const snapshot = ctx.store.load();
    const found = findProject(ctx, snapshot, ref);
    if (!('file' in found)) return found.code;
    return run(found.file, snapshot);
  });
}

function listProjects(ctx: CommandContext): number {
  const snapshot = loadWorld(ctx);
  const onlyStalled = hasFlag(ctx.args, 'stalled');
  const showAll = hasFlag(ctx.args, 'all');

  let entries = snapshot.membership.projects;
  if (onlyStalled) entries = stalledProjects(snapshot.membership);
  else if (!showAll) entries = entries.filter(e => e.project.project.state !== 'done');

  return emit(ctx, entries.map(toJson), () => {
    if (entries.length === 0) return onlyStalled ? 'Nothing is stalled.' : 'No projects yet.';

    const width = Math.max(...entries.map(e => e.project.stem.length));
    const lines = entries.map(entry => {
      const project = entry.project.project;
      const marks: string[] = [];
      if (entry.stalled) marks.push('STALLED');
      if (project.state !== 'active') marks.push(project.state);
      marks.push(`${entry.live.length} live`);
      if (entry.done.length > 0) marks.push(`${entry.done.length} done`);
      if (project.outcome.trim().length === 0) marks.push('no outcome');
      return `${entry.project.stem.padEnd(width)}  ${project.title}  (${marks.join(', ')})`;
    });

    const orphans = snapshot.membership.orphans;
    if (orphans.length > 0) {
      lines.push('');
      lines.push(`${pluralize(orphans.length, 'task')} point at a project that does not exist:`);
      for (const orphan of orphans) lines.push(`  ${orphan.file.stem} -> ${orphan.ref}`);
    }
    return lines;
  });
}

function newProject(ctx: CommandContext): number {
  const title = ctx.args.positional.join(' ').trim();
  const outcome = flagValue(ctx.args, 'outcome');

  if (title.length === 0) {
    return fail(
      ctx,
      'usage: omni project new "Kitchen renovation" --outcome "what done looks like"',
      EXIT_USAGE,
    );
  }
  if (outcome === undefined || outcome.trim().length === 0) {
    // Refused rather than defaulted. A project without an outcome is exactly what
    // GTD is trying to stop you accumulating.
    return fail(ctx, 'a project needs --outcome: what does done look like?', EXIT_USAGE, {
      hint: `omni project new "${title}" --outcome "..."`,
    });
  }

  return runWrite(ctx, () => {
    let planned;
    try {
      planned = planNewProject({
        id: ctx.store.mintId(),
        title,
        outcome,
        nowIso: ctx.now(),
        tags: flagList(ctx.args, 'tag'),
        ...(flagValue(ctx.args, 'due') === undefined ? {} : {due: flagValue(ctx.args, 'due')!}),
      });
    } catch (error) {
      return fail(ctx, error instanceof Error ? error.message : String(error), EXIT_USAGE);
    }

    const result = ctx.store.createProjectSafely(planned);
    if (result.kind !== 'ok') {
      return fail(ctx, result.kind === 'failed' ? result.reason : 'could not create', EXIT_ERROR);
    }

    return emitOk(
      ctx,
      {project: projectToJson(result.file, {liveActions: 0, stalled: true})},
      () => [
        `${result.file.stem}  ${result.file.project.title}`,
        `add actions with:  omni add "the next step" -p ${result.file.stem} --next`,
      ],
    );
  });
}

function showProject(ctx: CommandContext): number {
  const [ref] = ctx.args.positional;
  if (ref === undefined) return fail(ctx, 'usage: omni project show <project>', EXIT_USAGE);

  const snapshot = loadWorld(ctx);
  const found = findProject(ctx, snapshot, ref);
  if (!('file' in found)) return found.code;

  const entry = membershipFor(snapshot, found.file.project.id);
  const tasks = entry?.tasks ?? [];

  return emit(
    ctx,
    {
      ...(entry === undefined
        ? {project: projectToJson(found.file, {liveActions: 0, stalled: false})}
        : {project: toJson(entry)}),
      tasks: tasks.map(taskToJson),
    },
    () => {
      const lines = [readFileSync(found.file.path, 'utf8').trimEnd(), ''];
      lines.push(tasks.length === 0 ? 'No actions yet.' : 'Actions:');
      for (const task of tasks) {
        lines.push(`  ${shortId(task.task.id)}  ${task.task.state.padEnd(7)}  ${task.task.title}`);
      }
      if (entry?.stalled === true) {
        lines.push('');
        lines.push('This project is stalled: nothing in next or waiting can move it forward.');
      }
      return lines;
    },
  );
}

/**
 * Renaming is the one operation that has to reach outside the project's own file.
 *
 * Tasks refer to a project by its filename stem, so a rename rewrites every member in
 * one pass and records the old stem as an alias. The whole thing runs under a single
 * lock, so no agent can see the project renamed but its tasks not yet repointed.
 */
function renameProject(ctx: CommandContext): number {
  const [ref, ...titleParts] = ctx.args.positional;
  const title = titleParts.join(' ').trim();
  if (ref === undefined || title.length === 0) {
    return fail(ctx, 'usage: omni project rename <project> "New title"', EXIT_USAGE);
  }

  loadWorld(ctx);

  return runWrite(ctx, () =>
    withProject(ctx, ref, (current, snapshot) => {
      const previousStem = current.stem;
      const members = membershipFor(snapshot, current.project.id)?.tasks ?? [];

      const renamed = ctx.store.updateProject(current.project.id, project =>
        planRenameProject(project, previousStem, title),
      );
      if (renamed.kind !== 'ok') {
        return fail(ctx, renamed.kind === 'failed' ? renamed.reason : 'gone', EXIT_ERROR);
      }

      let repointed = 0;
      if (renamed.file.stem !== previousStem) {
        for (const member of members) {
          const result = ctx.store.updateTask(member.task.id, task => ({
            ...task,
            project: renamed.file.stem,
          }));
          if (result.kind === 'ok') repointed += 1;
        }
      }

      return emitOk(
        ctx,
        {
          project: projectToJson(renamed.file, {liveActions: 0, stalled: false}),
          previous_stem: previousStem,
          repointed,
        },
        () => {
          const lines = [
            renamed.file.stem === previousStem
              ? `${renamed.file.stem}  ${renamed.file.project.title}`
              : `${previousStem} -> ${renamed.file.stem}  ${renamed.file.project.title}`,
          ];
          if (repointed > 0) lines.push(`repointed ${pluralize(repointed, 'task')}`);
          return lines;
        },
      );
    }),
  );
}

function setOutcome(ctx: CommandContext): number {
  const [ref, ...rest] = ctx.args.positional;
  const outcome = (flagValue(ctx.args, 'outcome') ?? rest.join(' ')).trim();
  if (ref === undefined || outcome.length === 0) {
    return fail(ctx, 'usage: omni project outcome <project> "what done looks like"', EXIT_USAGE);
  }

  loadWorld(ctx);

  return runWrite(ctx, () =>
    withProject(ctx, ref, file => {
      const result = ctx.store.updateProject(file.project.id, project =>
        planSetOutcome(project, outcome),
      );
      if (result.kind !== 'ok') {
        return fail(ctx, result.kind === 'failed' ? result.reason : 'gone', EXIT_ERROR);
      }
      return emitOk(
        ctx,
        {project: projectToJson(result.file, {liveActions: 0, stalled: false})},
        () => `${result.file.stem}  ${result.file.project.outcome}`,
      );
    }),
  );
}

function completeProject(ctx: CommandContext): number {
  const [ref] = ctx.args.positional;
  if (ref === undefined) {
    return fail(ctx, 'usage: omni project done <project> [--note "..."]', EXIT_USAGE);
  }

  loadWorld(ctx);
  const note = flagValue(ctx.args, 'note');

  return runWrite(ctx, () =>
    withProject(ctx, ref, (file, snapshot) => {
      // Counted from the same snapshot the reference resolved against, inside the lock,
      // so nobody can finish the last open action between the check and the write.
      const entry = membershipFor(snapshot, file.project.id);
      const open = entry?.tasks.filter(t => t.task.state !== 'done') ?? [];
      if (open.length > 0 && !hasFlag(ctx.args, 'yes')) {
        return fail(
          ctx,
          `${file.project.title} still has ${pluralize(open.length, 'open action')}`,
          EXIT_USAGE,
          {
            open: open.map(t => `${t.task.state.padEnd(7)}  ${t.task.title}`),
            hint: 'finish or drop them first, or re-run with --yes',
          },
        );
      }

      const result = ctx.store.updateProject(file.project.id, project =>
        planCompleteProject(project, {nowIso: ctx.now(), ...(note === undefined ? {} : {note})}),
      );
      if (result.kind !== 'ok') {
        return fail(ctx, result.kind === 'failed' ? result.reason : 'gone', EXIT_ERROR);
      }
      return emitOk(
        ctx,
        {project: projectToJson(result.file, {liveActions: 0, stalled: false})},
        () => `done: ${result.file.project.title}`,
      );
    }),
  );
}

function moveProject(ctx: CommandContext): number {
  const [ref, target] = ctx.args.positional;
  if (ref === undefined || target === undefined) {
    return fail(ctx, 'usage: omni project mv <project> <active|someday|done>', EXIT_USAGE);
  }
  if (!isProjectState(target)) {
    return fail(ctx, `"${target}" is not a project state`, EXIT_USAGE);
  }

  loadWorld(ctx);

  return runWrite(ctx, () =>
    withProject(ctx, ref, file => {
      const result = ctx.store.updateProject(file.project.id, project =>
        planMoveProject(project, target, {nowIso: ctx.now()}),
      );
      if (result.kind !== 'ok') {
        return fail(ctx, result.kind === 'failed' ? result.reason : 'gone', EXIT_ERROR);
      }
      return emitOk(
        ctx,
        {project: projectToJson(result.file, {liveActions: 0, stalled: false})},
        () => `${result.file.stem}  ${result.file.project.title}  (${result.file.project.state})`,
      );
    }),
  );
}
