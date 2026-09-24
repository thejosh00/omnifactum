/**
 * `omni submit` — an agent hands finished work back for checking.
 *
 * This exists so that an agent finishing a task does not also get to decide the task is
 * finished. The work lands in `review/`, which is a queue a person drains, in the same
 * way `inbox/` is a queue for things not yet thought about. Accepting it is `omni done`;
 * sending it back is `omni mv <task> next --note "why"`.
 */
import {flagValue} from '../core/args.ts';
import {planSubmit} from '../core/mutation.ts';
import {shortId} from '../core/render.ts';
import {taskToJson} from '../core/serialize.ts';
import {
  EXIT_ERROR,
  EXIT_NOT_FOUND,
  EXIT_USAGE,
  actorOf,
  emitOk,
  fail,
  loadWorld,
  withTask,
  type Command,
} from './context.ts';
import {runWrite} from './modify.ts';

export const SUBMIT_FLAGS = {alias: {n: 'note', m: 'note', a: 'actor'}} as const;

export const submitCommand: Command = ctx => {
  const [ref] = ctx.args.positional;
  if (ref === undefined) {
    return fail(ctx, 'usage: omni submit <task> --note "what you did"', EXIT_USAGE);
  }

  const note = flagValue(ctx.args, 'note');
  if (note === undefined || note.trim().length === 0) {
    // Refused rather than defaulted. The note is the only thing the reviewer has.
    return fail(ctx, 'submitting needs --note: what did you do?', EXIT_USAGE, {
      hint: `omni submit ${ref} --note "..."`,
    });
  }

  loadWorld(ctx);

  return runWrite(ctx, () =>
    withTask(ctx, ref, file => {
      if (file.task.state === 'review') {
        return fail(ctx, `"${file.task.title}" is already waiting to be reviewed`, EXIT_ERROR, {
          task: taskToJson(file),
        });
      }
      if (file.task.state === 'done') {
        return fail(ctx, `"${file.task.title}" is already done`, EXIT_ERROR, {
          task: taskToJson(file),
        });
      }

      const result = ctx.store.updateTask(file.task.id, task =>
        planSubmit(task, {nowIso: ctx.now(), actor: actorOf(ctx), note}),
      );

      switch (result.kind) {
        case 'not-found':
          return fail(ctx, 'that task is no longer there', EXIT_NOT_FOUND);
        case 'failed':
        case 'stale':
          return fail(ctx, result.kind === 'failed' ? result.reason : 'the task changed; try again', EXIT_ERROR);
        case 'ok':
          return emitOk(
            ctx,
            {task: taskToJson(result.file)},
            () => `${shortId(result.file.task.id)}  ${result.file.task.title}  (for review)`,
          );
      }
    }),
  );
};
