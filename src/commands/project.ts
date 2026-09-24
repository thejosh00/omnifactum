/**
 * `omni project` — the first-class project entity.
 *
 * A project is an outcome that needs more than one action. It gets its own file so it
 * can carry the thing a tag cannot: a statement of what done looks like, and therefore
 * the ability to notice when nothing is moving it forward.
 */
import {flagList, flagValue, hasFlag} from '../core/args.ts';
import {resolveProjectRef, writeProject} from '../core/project.ts';
import {
  createProject,
  moveProject as moveSharedProject,
  ProjectError,
  projectJson,
  renameProject as renameSharedProject,
  setOutcome as setSharedOutcome,
} from '../db/projects.ts';
import {pluralize, shortId} from '../core/render.ts';
import {projectToJson, taskToJson} from '../core/serialize.ts';
import {membershipFor} from '../core/snapshot.ts';
import {stalledProjects} from '../core/stalled.ts';
import {isProjectState} from '../core/types.ts';
import type {ProjectMembership} from '../core/stalled.ts';
import type {Snapshot} from '../core/snapshot.ts';
import type {ProjectFile, ProjectState} from '../core/types.ts';
import {
  EXIT_BUSY,
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

  const due = flagValue(ctx.args, 'due');
  return changing(ctx, () => {
    const file = createProject(ctx.store, {
      title,
      outcome,
      nowIso: ctx.now(),
      tags: flagList(ctx.args, 'tag'),
      ...(due === undefined ? {} : {due}),
    });
    return emitOk(ctx, {project: projectJson(ctx.store, file)}, () => [
      `${file.stem}  ${file.project.title}`,
      `add actions with:  omni add "the next step" -p ${file.stem} --next`,
    ]);
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
      const lines = [writeProject(found.file.project, '').trimEnd(), ''];
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

function renameProject(ctx: CommandContext): number {
  const [ref, ...titleParts] = ctx.args.positional;
  const title = titleParts.join(' ').trim();
  if (ref === undefined || title.length === 0) {
    return fail(ctx, 'usage: omni project rename <project> "New title"', EXIT_USAGE);
  }

  loadWorld(ctx);
  return changing(ctx, () => {
    const {file, previousStem, repointed} = renameSharedProject(ctx.store, ref, title);
    return emitOk(
      ctx,
      {project: projectJson(ctx.store, file), previous_stem: previousStem, repointed},
      () => {
        const lines = [
          file.stem === previousStem
            ? `${file.stem}  ${file.project.title}`
            : `${previousStem} -> ${file.stem}  ${file.project.title}`,
        ];
        if (repointed > 0) lines.push(`repointed ${pluralize(repointed, 'task')}`);
        return lines;
      },
    );
  });
}

function setOutcome(ctx: CommandContext): number {
  const [ref, ...rest] = ctx.args.positional;
  const outcome = (flagValue(ctx.args, 'outcome') ?? rest.join(' ')).trim();
  if (ref === undefined || outcome.length === 0) {
    return fail(ctx, 'usage: omni project outcome <project> "what done looks like"', EXIT_USAGE);
  }

  loadWorld(ctx);
  return changing(ctx, () => {
    const file = setSharedOutcome(ctx.store, ref, outcome);
    return emitOk(ctx, {project: projectJson(ctx.store, file)}, () => `${file.stem}  ${file.project.outcome}`);
  });
}

function completeProject(ctx: CommandContext): number {
  const [ref] = ctx.args.positional;
  if (ref === undefined) {
    return fail(ctx, 'usage: omni project done <project> [--note "..."]', EXIT_USAGE);
  }
  return move(ctx, ref, 'done');
}

function moveProject(ctx: CommandContext): number {
  const [ref, target] = ctx.args.positional;
  if (ref === undefined || target === undefined) {
    return fail(ctx, 'usage: omni project mv <project> <active|someday|done>', EXIT_USAGE);
  }
  if (!isProjectState(target)) {
    return fail(ctx, `"${target}" is not a project state`, EXIT_USAGE);
  }
  return move(ctx, ref, target);
}

/** `done` and `mv` share one path, so finishing a project checks its open actions either way. */
function move(ctx: CommandContext, ref: string, to: ProjectState): number {
  loadWorld(ctx);
  const note = flagValue(ctx.args, 'note');
  return changing(ctx, () => {
    const file = moveSharedProject(ctx.store, ref, to, {
      nowIso: ctx.now(),
      actor: ctx.store.actor,
      force: hasFlag(ctx.args, 'yes'),
      ...(note === undefined ? {} : {note}),
    });
    return emitOk(ctx, {project: projectJson(ctx.store, file)}, () =>
      to === 'done' ? `done: ${file.project.title}` : `${file.stem}  ${file.project.title}  (${file.project.state})`,
    );
  });
}

/** Run a project change, turning what the shared module refuses into the CLI's exit codes. */
function changing(ctx: CommandContext, action: () => number): number {
  return runWrite(ctx, () => {
    try {
      return action();
    } catch (error) {
      if (!(error instanceof ProjectError)) throw error;
      switch (error.kind) {
        case 'not-found':
          return fail(ctx, error.message, EXIT_NOT_FOUND);
        case 'ambiguous':
          return fail(ctx, error.message, EXIT_NOT_FOUND, {
            candidates: (error.detail.candidates ?? []).map(f => `${f.stem}  ${f.project.title}`),
          });
        case 'open-actions':
          return fail(ctx, error.message, EXIT_USAGE, {
            open: (error.detail.open ?? []).map(t => `${t.task.state.padEnd(7)}  ${t.task.title}`),
            hint: 'finish or drop them first, or re-run with --yes',
          });
        case 'stale':
          return fail(ctx, error.message, EXIT_BUSY);
        default:
          return fail(ctx, error.message, EXIT_USAGE);
      }
    }
  });
}
