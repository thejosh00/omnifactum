/**
 * The commands that change a task: done, mv, note, tag, rm.
 *
 * Each reads flags, calls a pure planner in `core/mutation.ts`, and hands the *planner*
 * to the store, which re-reads the task inside the lock before applying it. That is
 * what makes these safe to run while a person is in the interface: the planner always
 * sees current state, so there is no stale copy to clobber.
 */
import {flagValue, hasFlag} from '../core/args.ts';
import {planAddTags, planComplete, planMove, planNote, planRemoveTags} from '../core/mutation.ts';
import {shortId} from '../core/render.ts';
import {taskToJson} from '../core/serialize.ts';
import {normalizeTag} from '../core/tags.ts';
import {isTaskState, taskStateChoices} from '../core/types.ts';
import type {Updated} from '../store/store.ts';
import type {TaskFile} from '../core/types.ts';
import {
  EXIT_BUSY,
  EXIT_ERROR,
  EXIT_NOT_FOUND,
  EXIT_OK,
  EXIT_USAGE,
  emitOk,
  fail,
  actorOf,
  loadWorld,
  withTask,
  type Command,
  type CommandContext,
} from './context.ts';
import {LockTimeoutError} from '../store/lock.ts';

export const DONE_FLAGS = {boolean: ['force'], alias: {n: 'note', m: 'note', a: 'actor'}} as const;
export const RM_FLAGS = {boolean: ['force', 'yes'], alias: {f: 'force', y: 'yes'}} as const;
export const MV_FLAGS = {alias: {a: 'actor', n: 'note', m: 'note'}} as const;
export const NOTE_FLAGS = {alias: {a: 'actor', n: 'note', m: 'note'}} as const;
export const TAG_FLAGS = {alias: {a: 'actor'}} as const;

/** Turn a store outcome into either an emitted result or an exit code. */
function settle(
  ctx: CommandContext,
  result: Updated<TaskFile>,
  human: (file: TaskFile) => string,
): number {
  switch (result.kind) {
    case 'ok':
      return emitOk(ctx, {task: taskToJson(result.file)}, () => human(result.file));
    case 'not-found':
      // Between resolving the reference and taking the lock, someone else finished it.
      return fail(ctx, 'that task is no longer there; something else changed it first', EXIT_NOT_FOUND);
    case 'failed':
      return fail(ctx, result.reason, EXIT_ERROR);
  }
}

/** Any command that writes shares this wrapper, so contention reports identically. */
export function runWrite(ctx: CommandContext, action: () => number): number {
  try {
    return action();
  } catch (error) {
    if (error instanceof LockTimeoutError) {
      return fail(ctx, error.message, EXIT_BUSY);
    }
    throw error;
  }
}

export const doneCommand: Command = ctx => {
  const [ref] = ctx.args.positional;
  if (ref === undefined) {
    return fail(ctx, 'usage: omni done <task> [--note "what you did"]', EXIT_USAGE);
  }

  // Accepting work is a person's call. An agent that skipped the guide would otherwise
  // quietly mark its own work finished, which is the exact thing `review/` exists to
  // prevent, so this is a rule rather than a convention.
  const actor = actorOf(ctx);
  if (actor.startsWith('agent:') && !hasFlag(ctx.args, 'force')) {
    return fail(
      ctx,
      'agents hand work back for review rather than completing it; use "omni submit"',
      EXIT_USAGE,
      {hint: `omni submit ${ref} --note "what you did"   (or --force to override)`},
    );
  }

  loadWorld(ctx);
  const note = flagValue(ctx.args, 'note');

  return runWrite(ctx, () =>
    withTask(ctx, ref, file => {
      if (file.task.state === 'done') {
        return fail(ctx, `"${file.task.title}" is already done`, EXIT_ERROR, {
          task: taskToJson(file),
        });
      }
      const result = ctx.store.updateTask(file.task.id, task =>
        planComplete(task, {
          nowIso: ctx.now(),
          actor: actorOf(ctx),
          ...(note === undefined ? {} : {note}),
        }),
      );
      return settle(ctx, result, updated => `done: ${updated.task.title}`);
    }),
  );
};

export const moveCommand: Command = ctx => {
  const [ref, target] = ctx.args.positional;
  if (ref === undefined || target === undefined) {
    return fail(ctx, `usage: omni mv <task> ${taskStateChoices()}`, EXIT_USAGE);
  }
  if (!isTaskState(target)) {
    return fail(ctx, `"${target}" is not a state`, EXIT_USAGE);
  }

  loadWorld(ctx);

  const note = flagValue(ctx.args, 'note');

  return runWrite(ctx, () =>
    withTask(ctx, ref, file => {
      const result = ctx.store.updateTask(file.task.id, task =>
        planMove(task, target, {
          nowIso: ctx.now(),
          actor: actorOf(ctx),
          // Sending reviewed work back wants a reason attached, so whoever picks it up
          // next can read why it came back.
          ...(note === undefined ? {} : {note}),
        }),
      );
      return settle(
        ctx,
        result,
        updated => `${shortId(updated.task.id)}  ${updated.task.title}  (${updated.task.state})`,
      );
    }),
  );
};

/**
 * `omni note <task> "what happened"` — a log entry and nothing else.
 *
 * Progress is not always a state change. An agent halfway through a long job, or a
 * person recording that the supplier finally called back, has something worth writing
 * down and no move to make. Without this the only way to leave a record is to move the
 * task somewhere it does not belong, which is how a state stops meaning what it says.
 */
export const noteCommand: Command = ctx => {
  const [ref, ...rest] = ctx.args.positional;
  const text = (flagValue(ctx.args, 'note') ?? rest.join(' ')).trim();
  if (ref === undefined || text.length === 0) {
    return fail(ctx, 'usage: omni note <task> "what happened"', EXIT_USAGE);
  }

  loadWorld(ctx);

  return runWrite(ctx, () =>
    withTask(ctx, ref, file => {
      const result = ctx.store.updateTask(file.task.id, task =>
        planNote(task, {nowIso: ctx.now(), actor: actorOf(ctx), note: text}),
      );
      return settle(ctx, result, updated => `${shortId(updated.task.id)}  noted`);
    }),
  );
};

/** `omni tag <task> +home -errand` */
export const tagCommand: Command = ctx => {
  const [ref, ...changes] = ctx.args.positional;
  if (ref === undefined || changes.length === 0) {
    return fail(ctx, 'usage: omni tag <task> +add -remove', EXIT_USAGE);
  }

  loadWorld(ctx);

  const add: string[] = [];
  const remove: string[] = [];
  for (const change of changes) {
    if (change.startsWith('-')) remove.push(normalizeTag(change.slice(1)));
    else add.push(normalizeTag(change.replace(/^\+/, '')));
  }

  return runWrite(ctx, () =>
    withTask(ctx, ref, file => {
      // Adding and removing are expressed against whatever the tags are when the lock
      // is held, so two agents tagging the same task both get their tag.
      const result = ctx.store.updateTask(file.task.id, task =>
        planRemoveTags(planAddTags(task, add), remove),
      );
      return settle(ctx, result, updated =>
        updated.task.tags.length > 0
          ? `${shortId(updated.task.id)}  ${updated.task.tags.map(t => `#${t}`).join(' ')}`
          : `${shortId(updated.task.id)}  no tags`,
      );
    }),
  );
};

/**
 * Delete a task. There is no trash and no version history, by decision, so this is
 * final and it asks first unless told not to.
 */
export const removeCommand: Command = ctx => {
  const [ref] = ctx.args.positional;
  if (ref === undefined) {
    return fail(ctx, 'usage: omni rm <task> --yes', EXIT_USAGE);
  }

  loadWorld(ctx);

  return runWrite(ctx, () =>
    withTask(ctx, ref, file => {
      if (!hasFlag(ctx.args, 'yes') && !hasFlag(ctx.args, 'force')) {
        // Parking it in someday is the gentler alternative to deleting a live task, and
        // no alternative at all for a finished one: there is nothing left to defer.
        const hint =
          file.task.state === 'done'
            ? 're-run with --yes'
            : `re-run with --yes, or use "omni mv ${ref} someday" instead`;
        return fail(
          ctx,
          `"${file.task.title}" would be deleted permanently. There is no undo.`,
          EXIT_USAGE,
          {hint},
        );
      }

      const result = ctx.store.removeTask(file.task.id);
      if (result.kind === 'not-found') {
        return fail(ctx, 'that task is no longer there', EXIT_NOT_FOUND);
      }
      if (result.kind === 'failed') return fail(ctx, result.reason, EXIT_ERROR);
      return emitOk(
        ctx,
        {deleted: taskToJson(result.file)},
        () => `deleted: ${result.file.task.title}`,
      );
    }),
  );
};

export {EXIT_OK};
