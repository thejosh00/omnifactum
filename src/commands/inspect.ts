/**
 * Read-only commands: show and tags.
 *
 * `show --json` is how an agent reads one task. Without `--json` a task prints in the
 * markdown form it used to be stored in, which is still the easiest way to read one.
 */
import {writeTask} from '../core/task.ts';
import {pluralize} from '../core/render.ts';
import {taskToJson} from '../core/serialize.ts';
import {
  EXIT_USAGE,
  emit,
  fail,
  loadWorld,
  requireTask,
  type Command,
} from './context.ts';

export const SHOW_FLAGS = {boolean: ['raw']} as const;

export const showCommand: Command = ctx => {
  const [ref] = ctx.args.positional;
  if (ref === undefined) return fail(ctx, 'usage: omni show <task>', EXIT_USAGE);

  const found = requireTask(ctx, loadWorld(ctx), ref);
  if (!('file' in found)) return found.code;

  return emit(ctx, taskToJson(found.file), () => writeTask(found.file.task, '').trimEnd());
};

export const tagsCommand: Command = ctx => {
  const snapshot = loadWorld(ctx);

  return emit(
    ctx,
    snapshot.tags.map(use => ({tag: use.tag, count: use.count, last_used: use.lastUsed})),
    () => {
      if (snapshot.tags.length === 0) return 'No tags yet. They appear as soon as you use them.';
      const width = Math.max(...snapshot.tags.map(use => use.tag.length));
      return snapshot.tags.map(use => `${use.tag.padEnd(width)}  ${pluralize(use.count, 'task')}`);
    },
  );
};
