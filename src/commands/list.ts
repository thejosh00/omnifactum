import {flagList, hasFlag} from '../core/args.ts';
import {filterTasks, parseQuery, queryFromFlags} from '../core/filter.ts';
import {renderTaskList} from '../core/render.ts';
import {taskToJson} from '../core/serialize.ts';
import {byDueDate, isDeferred} from '../core/tickler.ts';
import {isTaskState, taskStateList} from '../core/types.ts';
import type {Query} from '../core/filter.ts';
import type {TaskFile, TaskState} from '../core/types.ts';
import {
  EXIT_OK,
  EXIT_USAGE,
  emit,
  fail,
  loadWorld,
  type Command,
  type CommandContext,
} from './context.ts';

export const LIST_FLAGS = {
  boolean: ['all', 'done'],
  alias: {t: 'tag', n: 'not', a: 'any', s: 'state'},
} as const;

/**
 * `omni list` and its per-state shorthands.
 *
 * The query can be given positionally (`omni list "home,errand -waiting"`) or as
 * flags (`omni list -t home --not waiting`). Both produce the same query, because the
 * shell makes `-tag` and `!tag` awkward to type while a filter bar does not.
 *
 * With `--json` this is the agent's read API: a bare array of task objects, which is
 * what `jq` and every other tool expects to be handed.
 */
export function listCommand(defaultState?: TaskState): Command {
  return ctx => {
    const requested = defaultState ?? ctx.args.flags.get('state')?.[0];
    // A state we do not recognise is refused rather than ignored. Falling through to
    // the default list is how `-s review` came to print the next actions instead, and a
    // silently wrong list is worse than an error for a person and an agent alike.
    if (requested !== undefined && !isTaskState(requested)) {
      return fail(ctx, `state must be one of ${taskStateList()}`, EXIT_USAGE);
    }
    const state: TaskState | undefined = requested;

    const snapshot = loadWorld(ctx);
    const query = buildQuery(ctx);

    let files = snapshot.tasks;
    if (state !== undefined) {
      files = files.filter(file => file.task.state === state);
    } else if (!hasFlag(ctx.args, 'all') && !mentionsState(query)) {
      // A bare `omni list` means the actionable list, not everything ever captured.
      files = files.filter(file => file.task.state === 'next');
    }

    files = filterTasks(files, query, {nowIso: ctx.now()});

    // Deferred tasks are not ready yet, so they stay out of the way unless asked for.
    if (!hasFlag(ctx.args, 'all')) {
      files = files.filter(file => !isDeferred(file.task, ctx.now()));
    }

    return emit(ctx, files.map(taskToJson), () =>
      renderTaskList(files, {
        showState: state === undefined,
        empty: emptyMessage(state),
      }),
    );
  };
}

/** Deadline-ordered across every state. */
export const dueCommand: Command = ctx => {
  const snapshot = loadWorld(ctx);
  const query = buildQuery(ctx);

  const files = filterTasks(
    snapshot.tasks.filter(file => file.task.due !== undefined && file.task.state !== 'done'),
    query,
    {nowIso: ctx.now()},
  ).sort((a, b) => byDueDate(a.task, b.task));

  return emit(ctx, files.map(taskToJson), () =>
    renderTaskList(files, {showState: true, empty: 'Nothing has a deadline.'}),
  );
};

function buildQuery(ctx: CommandContext): Query {
  const positional = ctx.args.positional.join(' ').trim();
  const parsed = parseQuery(positional);
  // Warnings would corrupt an agent's parse if they went to stdout, and an agent that
  // typoed a filter wants a non-empty result set even less than a person does.
  if (!ctx.json) for (const warning of parsed.warnings) ctx.err(warning);

  return [
    ...parsed.query,
    ...queryFromFlags({
      tags: flagList(ctx.args, 'tag'),
      not: flagList(ctx.args, 'not'),
      any: flagList(ctx.args, 'any'),
    }),
  ];
}

function mentionsState(query: Query): boolean {
  return query.some(term => term.atoms.some(atom => atom.kind === 'state'));
}

/**
 * Keyed by state rather than switched on, so a new state is a type error here instead
 * of a list that quietly says "Nothing matches."
 */
const EMPTY_MESSAGES: Record<TaskState, string> = {
  inbox: 'Inbox zero.',
  next: 'No next actions match.',
  waiting: 'Not waiting on anything.',
  someday: 'Nothing on the someday list.',
  review: 'Nothing waiting to be checked.',
  done: 'Nothing completed yet.',
};

function emptyMessage(state: TaskState | undefined): string {
  return state === undefined ? 'Nothing matches.' : EMPTY_MESSAGES[state];
}

/** Shared by the interactive UI, so both see exactly the same result for a query. */
export function applyQuery(files: readonly TaskFile[], query: Query, nowIso: string): TaskFile[] {
  return filterTasks(files, query, {nowIso});
}

export {EXIT_OK};
