/**
 * What every subcommand is handed, and the few things they all need to do.
 *
 * Commands stay thin: they read flags, call a pure planner in `core/`, hand the result
 * to the store, and emit. Any logic worth testing belongs in core, not here.
 *
 * Output has two shapes. A person gets aligned text on stdout and problems on stderr.
 * An agent passing `--json` gets JSON on stdout and *nothing* on stderr, including for
 * failures, so one parse handles every outcome and a non-zero exit never leaves a
 * caller guessing what went wrong.
 */
import {resolveIdPrefix} from '../core/id.ts';
import {failure, ok, renderJson} from '../core/serialize.ts';
import {sweepTickler} from '../db/tickler.ts';
import type {ParsedArgs} from '../core/args.ts';
import type {Snapshot} from '../core/snapshot.ts';
import type {TaskFile} from '../core/types.ts';
import type {Store} from '../db/store.ts';

export const EXIT_OK = 0;
export const EXIT_ERROR = 1;
export const EXIT_USAGE = 2;
export const EXIT_NOT_FOUND = 3;
/** Someone else was writing and we could not get in. Distinct so a caller can retry. */
export const EXIT_BUSY = 4;

export interface CommandContext {
  store: Store;
  args: ParsedArgs;
  now: () => string;
  out: (line?: string) => void;
  err: (line?: string) => void;
  /** True when the caller asked for machine-readable output. */
  json: boolean;
}

export type Command = (ctx: CommandContext) => number;

/**
 * Report a result. `data` is emitted as JSON for an agent; `human` is only called when
 * a person is reading, so building the text costs nothing in JSON mode.
 */
export function emit(ctx: CommandContext, data: unknown, human: () => string | string[]): number {
  if (ctx.json) {
    ctx.out(renderJson(data));
    return EXIT_OK;
  }
  const rendered = human();
  for (const line of Array.isArray(rendered) ? rendered : [rendered]) ctx.out(line);
  return EXIT_OK;
}

/**
 * Report a failure, and return the exit code so a command can `return fail(...)`.
 * In JSON mode this goes to stdout as an envelope, because an agent should never have
 * to read two streams to find out what happened.
 */
export function fail(
  ctx: CommandContext,
  message: string,
  code: number = EXIT_ERROR,
  extra: Record<string, unknown> = {},
): number {
  if (ctx.json) {
    ctx.out(renderJson(failure(message, code, extra)));
  } else {
    ctx.err(message);
    for (const value of Object.values(extra)) {
      if (Array.isArray(value)) for (const line of value) ctx.err(`  ${String(line)}`);
      else if (typeof value === 'string') ctx.err(value);
    }
  }
  return code;
}

/** A successful mutation, in the shape every mutation shares. */
export function emitOk(
  ctx: CommandContext,
  fields: Record<string, unknown>,
  human: () => string | string[],
): number {
  return emit(ctx, ok(fields), human);
}

/**
 * Promote any `someday/` task whose defer date has arrived.
 *
 * The server also does this on a timer, so this is a backstop: a command that runs just
 * after midnight sees the deferred task where it now belongs, rather than a minute
 * later. Promotion is idempotent and leaves a log line, so running it twice is harmless.
 */
export function runTicklerSweep(ctx: CommandContext, snapshot: Snapshot): Snapshot {
  const promoted = sweepTickler(ctx.store, ctx.now());
  if (promoted === 0) return snapshot;
  // Never on stdout: it would corrupt an agent's parse and surprise a script.
  if (!ctx.json) {
    ctx.err(`promoted ${promoted} deferred ${promoted === 1 ? 'task' : 'tasks'} to next`);
  }
  return ctx.store.load();
}

/** Load the world, having first let any deferred tasks surface. */
export function loadWorld(ctx: CommandContext): Snapshot {
  return runTicklerSweep(ctx, ctx.store.load());
}

export type Resolved =
  | {kind: 'ok'; file: TaskFile}
  | {kind: 'error'; message: string; code: number; candidates?: string[]};

/**
 * Find a task from something a person or an agent typed: a full id, an unambiguous id
 * prefix, or a filename stem.
 */
export function resolveTask(snapshot: Snapshot, ref: string): Resolved {
  const trimmed = ref.trim();
  if (trimmed.length === 0) {
    return {kind: 'error', message: 'no task given', code: EXIT_USAGE};
  }

  const byStem = snapshot.tasks.filter(file => file.stem === trimmed);
  if (byStem.length === 1) return {kind: 'ok', file: byStem[0]!};
  if (byStem.length > 1) return ambiguous(trimmed, byStem);

  const resolved = resolveIdPrefix(
    snapshot.tasks.map(file => file.task.id),
    trimmed,
  );
  if (resolved.kind === 'ok') {
    const file = snapshot.byId.get(resolved.id);
    if (file !== undefined) return {kind: 'ok', file};
  }
  if (resolved.kind === 'ambiguous') {
    return ambiguous(
      trimmed,
      resolved.candidates
        .map(id => snapshot.byId.get(id))
        .filter((file): file is TaskFile => file !== undefined),
    );
  }
  return {
    kind: 'error',
    message: `no task matches "${trimmed}"`,
    code: EXIT_NOT_FOUND,
  };
}

function ambiguous(ref: string, candidates: TaskFile[]): Resolved {
  return {
    kind: 'error',
    message: `"${ref}" matches more than one task`,
    code: EXIT_NOT_FOUND,
    candidates: candidates.map(file => `${file.task.id}  ${file.task.title}`),
  };
}

/**
 * Resolve a reference and change the task, both inside one lock.
 *
 * Both halves have to be in the same lock. Resolving first and locking second looks
 * harmless but is not: a task being moved between directories by someone else is
 * briefly absent from the directory the scan has already walked, so an unlocked resolve
 * can fail to find a task that certainly exists. Holding the lock across both makes the
 * whole tree still while the reference is looked up.
 */
export function withTask(
  ctx: CommandContext,
  ref: string,
  run: (file: TaskFile) => number,
): number {
  return ctx.store.batch(() => {
    const found = requireTask(ctx, ctx.store.load(), ref);
    if (!('file' in found)) return found.code;
    return run(found.file);
  });
}

/** Resolve or report. Returns undefined when it failed, with the code in `code`. */
export function requireTask(
  ctx: CommandContext,
  snapshot: Snapshot,
  ref: string,
): {file: TaskFile} | {code: number} {
  const found = resolveTask(snapshot, ref);
  if (found.kind === 'ok') return {file: found.file};
  return {
    code: fail(
      ctx,
      found.message,
      found.code,
      found.candidates === undefined ? {} : {candidates: found.candidates},
    ),
  };
}

/**
 * Who is making this change, as recorded in the task's log.
 *
 * The server decides this from the caller's token, and any `--actor` or `OMNI_ACTOR`
 * has already been applied when the token allows it. An agent's token always names
 * that agent, so it cannot claim to be a person to get past the review rule.
 */
export function actorOf(ctx: CommandContext): string {
  return ctx.store.actor;
}

export function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
