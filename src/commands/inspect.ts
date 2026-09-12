/**
 * Read-only commands: show, path, tags.
 *
 * `show --json` is how an agent reads one task. `path` still exists so a person, or an
 * agent that wants the raw markdown, can get straight to the file.
 */
import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {pluralize} from '../core/render.ts';
import {taskToJson} from '../core/serialize.ts';
import {
  EXIT_ERROR,
  EXIT_OK,
  EXIT_USAGE,
  describe,
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

  // Without --json a person wants the file as written, comments and all.
  return emit(ctx, taskToJson(found.file), () => readFileSync(found.file.path, 'utf8').trimEnd());
};

/** With no argument, the data directory. With one, that task's absolute path. */
export const pathCommand: Command = ctx => {
  const [ref] = ctx.args.positional;
  if (ref === undefined) {
    return emit(ctx, {path: ctx.dataDir}, () => ctx.dataDir);
  }

  const found = requireTask(ctx, loadWorld(ctx), ref);
  if (!('file' in found)) return found.code;

  return emit(ctx, {path: found.file.path}, () => found.file.path);
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

/**
 * Open a task in `$EDITOR`.
 *
 * The app deliberately hands over the raw file rather than mediating the edit. This is
 * the one write path that does not take the lock, because an editor session can last
 * minutes and holding a lock that long would block every agent. The mtime-and-size
 * check is what covers it.
 */
export const editCommand: Command = ctx => {
  const [ref] = ctx.args.positional;
  if (ref === undefined) return fail(ctx, 'usage: omni edit <task>', EXIT_USAGE);

  if (ctx.json) {
    return fail(ctx, 'omni edit needs a terminal; use "omni path" and edit the file', EXIT_USAGE);
  }

  const found = requireTask(ctx, loadWorld(ctx), ref);
  if (!('file' in found)) return found.code;

  const editor = process.env['VISUAL'] ?? process.env['EDITOR'];
  if (editor === undefined || editor.trim().length === 0) {
    return fail(ctx, 'set $EDITOR to edit a task', EXIT_ERROR, {hint: found.file.path});
  }

  try {
    const result = spawnSync(editor, [found.file.path], {stdio: 'inherit', shell: true});
    if (result.error !== undefined) throw result.error;
    return result.status === 0 ? EXIT_OK : EXIT_ERROR;
  } catch (error) {
    return fail(ctx, describe(error), EXIT_ERROR);
  }
};
