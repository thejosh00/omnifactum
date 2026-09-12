import {flagList, flagValue} from '../core/args.ts';
import {planNewTask} from '../core/mutation.ts';
import {resolveProjectRef} from '../core/project.ts';
import {shortId} from '../core/render.ts';
import {taskToJson} from '../core/serialize.ts';
import {isTaskState, taskStateList} from '../core/types.ts';
import type {TaskState} from '../core/types.ts';
import {
  EXIT_ERROR,
  EXIT_USAGE,
  actorOf,
  describe,
  emitOk,
  fail,
  type Command,
  type CommandContext,
} from './context.ts';
import {runWrite} from './modify.ts';

export const ADD_FLAGS = {
  boolean: ['next', 'waiting', 'someday'],
  alias: {t: 'tag', p: 'project', s: 'state', w: 'waiting-on', n: 'note', d: 'due', a: 'actor'},
} as const;

export const addCommand: Command = ctx => {
  const title = ctx.args.positional.join(' ').trim();
  if (title.length === 0) {
    return fail(
      ctx,
      'usage: omni add "the task" [-t tag] [-s state] [-p project] [--due date]',
      EXIT_USAGE,
    );
  }

  const state = chosenState(ctx.args.booleans, flagValue(ctx.args, 'state'));
  if (state === undefined) {
    return fail(ctx, `state must be one of ${taskStateList()}`, EXIT_USAGE);
  }

  const defer = flagValue(ctx.args, 'defer');
  if (defer !== undefined && state !== 'someday') {
    // Keeping defer to someday/ is what lets next/ be taken at face value.
    return fail(ctx, '--defer only applies to someday tasks; add -s someday as well', EXIT_USAGE);
  }

  const project = resolveProject(ctx, flagValue(ctx.args, 'project'));

  return runWrite(ctx, () => {
    let planned;
    try {
      planned = planNewTask({
        id: ctx.store.mintId(),
        title,
        state,
        nowIso: ctx.now(),
        actor: actorOf(ctx),
        tags: flagList(ctx.args, 'tag'),
        ...optional('project', project),
        ...optional('due', flagValue(ctx.args, 'due')),
        ...optional('defer', defer),
        ...optional('waitingOn', flagValue(ctx.args, 'waiting-on')),
        ...optional('note', flagValue(ctx.args, 'note')),
      });
    } catch (error) {
      return fail(ctx, describe(error), EXIT_USAGE);
    }

    const result = ctx.store.createTask(planned);
    if (result.kind !== 'ok') {
      return fail(ctx, result.kind === 'failed' ? result.reason : 'could not create', EXIT_ERROR);
    }

    return emitOk(
      ctx,
      {task: taskToJson(result.file)},
      () => `${shortId(result.file.task.id)}  ${result.file.task.title}  (${result.file.task.state})`,
    );
  });
};

function optional<K extends string>(key: K, value: string | undefined): Record<string, string> {
  return value === undefined ? {} : {[key]: value};
}

/**
 * Store the project's canonical filename stem, whatever the caller typed.
 *
 * This keeps the `project:` field readable and consistent, so `-p` accepts an id or a
 * title while the file still says `project: renovate-kitchen`. A reference that does
 * not resolve is kept anyway and reported: the project may be about to be created, and
 * `omni project list` surfaces the dangling link either way.
 */
function resolveProject(ctx: CommandContext, ref: string | undefined): string | undefined {
  if (ref === undefined) return undefined;

  const match = resolveProjectRef(ctx.store.load().projects, ref);
  if (match.kind === 'ok') return match.project.stem;

  // A warning, not a failure — and never on stdout, which an agent is parsing.
  if (!ctx.json) {
    ctx.err(
      match.kind === 'ambiguous'
        ? `"${ref}" matches more than one project; using it as written`
        : `no project named "${ref}" yet; the link will dangle until you create one`,
    );
  }
  return ref;
}

function chosenState(booleans: Set<string>, flag: string | undefined): TaskState | undefined {
  for (const shortcut of ['next', 'waiting', 'someday'] as const) {
    if (booleans.has(shortcut)) return shortcut;
  }
  if (flag === undefined) return 'inbox';
  return isTaskState(flag) ? flag : undefined;
}
