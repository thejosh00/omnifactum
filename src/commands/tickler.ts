/**
 * `omni tickler` — reminders that come back as next actions.
 *
 * A tickler item fires weekly, monthly, or once on a date, and each firing puts a task
 * tagged `#tickler` in next. See `db/tickler.ts` for when a firing holds off.
 */
import {flagValue, hasFlag} from '../core/args.ts';
import {
  monthlyOn,
  onceOn,
  parseSchedule,
  shortDay,
  ticklerToJson,
  weeklyOn,
  describeSchedule,
  type ScheduleParse,
} from '../core/recurrence.ts';
import {shortId} from '../core/render.ts';
import {createTickler, findTickler} from '../db/tickler.ts';
import type {TicklerFile} from '../core/recurrence.ts';
import {EXIT_NOT_FOUND, EXIT_USAGE, emit, emitOk, fail, loadWorld, type Command, type CommandContext} from './context.ts';
import {runWrite} from './modify.ts';

export const TICKLER_FLAGS = {
  boolean: ['yes'],
  alias: {y: 'yes'},
} as const;

export const ticklerCommand: Command = ctx => {
  const [sub, ...rest] = ctx.args.positional;
  const inner: CommandContext = {...ctx, args: {...ctx.args, positional: rest}};

  switch (sub) {
    case undefined:
    case 'list':
    case 'ls':
      return listTicklers(inner);
    case 'add':
    case 'new':
      return addTickler(inner);
    case 'rm':
    case 'remove':
    case 'delete':
      return removeTickler(inner);
    default:
      return fail(ctx, `omni tickler: "${sub}" is not a subcommand`, EXIT_USAGE, {hint: 'try: list, add, rm'});
  }
};

function line(file: TicklerFile): string {
  const {tickler} = file;
  return `${shortId(tickler.id)}  ${tickler.title}  (${describeSchedule(tickler.schedule)}; next ${shortDay(tickler.nextOn)})`;
}

function listTicklers(ctx: CommandContext): number {
  // Loading the world runs the sweep, so what is listed has already fired if it was due.
  loadWorld(ctx);
  const files = ctx.store.listTicklers();
  return emit(ctx, files.map(ticklerToJson), () =>
    files.length === 0 ? 'No tickler items yet.' : files.map(line),
  );
}

const ADD_USAGE = 'usage: omni tickler add "Title" --every <weekday> | --monthly <1-31> | --on <date>';

function addTickler(ctx: CommandContext): number {
  const title = ctx.args.positional.join(' ').trim();
  if (title.length === 0) return fail(ctx, ADD_USAGE, EXIT_USAGE);

  const every = flagValue(ctx.args, 'every');
  const monthly = flagValue(ctx.args, 'monthly');
  const on = flagValue(ctx.args, 'on');
  const given = [every, monthly, on].filter(value => value !== undefined);
  if (given.length !== 1) return fail(ctx, 'give exactly one of --every, --monthly or --on', EXIT_USAGE, {hint: ADD_USAGE});

  let parsed: ScheduleParse;
  if (every !== undefined) parsed = every.includes(':') ? parseSchedule(every, ctx.now()) : weeklyOn(every);
  else if (monthly !== undefined) parsed = monthlyOn(monthly);
  else parsed = onceOn(on!, ctx.now());
  if (!parsed.ok) return fail(ctx, parsed.error, EXIT_USAGE);

  const schedule = parsed.schedule;
  return runWrite(ctx, () => {
    const file = createTickler(ctx.store, title, schedule, ctx.now());
    const fired = ctx.store.getTickler(file.tickler.id) === undefined;
    return emitOk(ctx, {tickler: ticklerToJson(file)}, () =>
      fired ? `${title}: due today, added to next` : line(file),
    );
  });
}

function removeTickler(ctx: CommandContext): number {
  const [ref] = ctx.args.positional;
  if (ref === undefined) return fail(ctx, 'usage: omni tickler rm <id> --yes', EXIT_USAGE);

  const found = findTickler(ctx.store, ref);
  if (found === undefined) return fail(ctx, `no tickler item matches "${ref}"`, EXIT_NOT_FOUND);
  if ('ambiguous' in found) {
    return fail(ctx, `"${ref}" matches more than one tickler item`, EXIT_NOT_FOUND, {
      candidates: found.ambiguous.map(line),
    });
  }
  if (!hasFlag(ctx.args, 'yes')) {
    return fail(ctx, `this deletes "${found.tickler.title}" permanently; add --yes`, EXIT_USAGE);
  }

  return runWrite(ctx, () => {
    const removed = ctx.store.removeTickler(found.tickler.id);
    if (removed.kind !== 'ok') return fail(ctx, 'that tickler item is no longer there', EXIT_NOT_FOUND);
    return emitOk(ctx, {deleted: ticklerToJson(removed.file)}, () => `deleted: ${found.tickler.title}`);
  });
}
