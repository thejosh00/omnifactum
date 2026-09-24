/**
 * Running one command against one account.
 *
 * This is the server side of the command line. The `omni` binary on your machine sends
 * its arguments to the server, which runs the command here, against the account the
 * caller's token belongs to, and sends back what it printed and its exit code. So every
 * command, flag, message and JSON shape is defined exactly once, and an agent on
 * another machine gets the same answers as one on this one.
 *
 * Nothing here touches the process: no environment, no stdout, no exit.
 */
import {parseArgs} from '../core/args.ts';
import {nowIso} from '../core/time.ts';
import {isBusy} from '../db/busy.ts';
import type {Store} from '../db/store.ts';
import {LIST_STATES, type TaskState} from '../core/types.ts';
import type {FlagSpec} from '../core/args.ts';
import {addCommand, ADD_FLAGS} from './add.ts';
import {agentsCommand} from './agents.ts';
import {dueCommand, listCommand, LIST_FLAGS} from './list.ts';
import {showCommand, tagsCommand} from './inspect.ts';
import {projectCommand, PROJECT_FLAGS} from './project.ts';
import {submitCommand, SUBMIT_FLAGS} from './submit.ts';
import {weeklyCommand, WEEKLY_FLAGS} from './weekly.ts';
import {
  doneCommand,
  DONE_FLAGS,
  moveCommand,
  MV_FLAGS,
  noteCommand,
  NOTE_FLAGS,
  removeCommand,
  RM_FLAGS,
  tagCommand,
  TAG_FLAGS,
} from './modify.ts';
import {
  EXIT_BUSY,
  EXIT_ERROR,
  EXIT_OK,
  EXIT_USAGE,
  describe,
  fail,
  type Command,
  type CommandContext,
} from './context.ts';

interface Entry {
  run: Command;
  flags: FlagSpec;
  summary: string;
}

/**
 * What each per-state listing says it is for.
 *
 * Keyed by the state rather than written out as commands, so a new state is a type
 * error here — which is what `review` should have been, instead of a list command
 * nobody registered a shorthand for until later.
 */
const LIST_SUMMARIES: Record<Exclude<TaskState, 'done'>, string> = {
  inbox: 'what has been captured',
  next: 'what you can do now',
  waiting: 'what others owe you',
  someday: 'what is not now',
  review: 'work waiting for you to check',
};

const STATE_COMMANDS: Record<string, Entry> = Object.fromEntries(
  LIST_STATES.map(state => [
    state,
    {run: listCommand(state), flags: LIST_FLAGS, summary: LIST_SUMMARIES[state]},
  ]),
);

const COMMANDS: Record<string, Entry> = {
  add: {run: addCommand, flags: ADD_FLAGS, summary: 'capture a task'},
  list: {run: listCommand(), flags: LIST_FLAGS, summary: 'list tasks matching a query'},
  ...STATE_COMMANDS,
  done: {run: doneCommand, flags: DONE_FLAGS, summary: 'accept a task as finished'},
  submit: {run: submitCommand, flags: SUBMIT_FLAGS, summary: 'hand finished work back for review'},
  weekly: {run: weeklyCommand, flags: WEEKLY_FLAGS, summary: 'the GTD weekly review, list by list'},
  due: {run: dueCommand, flags: LIST_FLAGS, summary: 'deadlines, soonest first'},
  mv: {run: moveCommand, flags: MV_FLAGS, summary: 'move a task to another state'},
  note: {run: noteCommand, flags: NOTE_FLAGS, summary: 'record what happened, changing nothing'},
  rm: {run: removeCommand, flags: RM_FLAGS, summary: 'delete a task permanently'},
  tag: {run: tagCommand, flags: TAG_FLAGS, summary: 'add and remove tags'},
  tags: {run: tagsCommand, flags: {}, summary: 'every tag in use, with counts'},
  show: {run: showCommand, flags: {}, summary: 'print one task in full'},
  project: {run: projectCommand, flags: PROJECT_FLAGS, summary: 'outcomes that need more than one action'},
  agents: {run: agentsCommand, flags: {}, summary: 'print the contract agents read'},
};

/** Every command name, so the contract tests can check the document only cites real ones. */
export const COMMAND_NAMES: string[] = Object.keys(COMMANDS);

/** Names that mean the same thing, so muscle memory from other tools works. */
const ALIASES: Record<string, string> = {
  ls: 'list',
  a: 'add',
  new: 'add',
  complete: 'done',
  move: 'mv',
  delete: 'rm',
  remove: 'rm',
  cat: 'show',
  projects: 'project',
  p: 'project',
};

export const COMMAND_ALIASES: Record<string, string> = ALIASES;

/** The summaries, for the client's usage text. */
export function commandSummaries(): Array<[string, string]> {
  return Object.entries(COMMANDS).map(([name, entry]) => [name, entry.summary]);
}


export interface CommandRequest {
  argv: readonly string[];
  /**
   * Who the caller would like the log to name, from `--actor` or `OMNI_ACTOR`. Only
   * honoured when the store's actor is a person: an agent's token always speaks for
   * that agent, so it cannot pass itself off as a person to get round the review rule.
   */
  actor?: string;
  now?: () => string;
}

export interface CommandResult {
  code: number;
  stdout: string[];
  stderr: string[];
}

function effectiveStore(store: Store, requested: string | undefined): Store {
  const wanted = requested?.trim();
  if (wanted === undefined || wanted.length === 0) return store;
  if (store.actor.startsWith('agent:')) return store;
  return store.as(wanted);
}

export function runCommand(baseStore: Store, request: CommandRequest): CommandResult {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const out = (line?: string) => stdout.push(line ?? '');
  const err = (line?: string) => stderr.push(line ?? '');
  const done = (code: number): CommandResult => ({code, stdout, stderr});

  const {json, rest: remaining} = liftJson(request.argv);
  const [name, ...rest] = remaining;
  const resolved = name === undefined ? undefined : (ALIASES[name] ?? name);
  const entry = resolved === undefined ? undefined : COMMANDS[resolved];

  const context: CommandContext = {
    store: baseStore,
    args: {positional: [], flags: new Map(), booleans: new Set(), errors: []},
    now: request.now ?? nowIso,
    out,
    err,
    json,
  };

  if (entry === undefined) {
    return done(
      fail(context, name === undefined ? 'no command given' : `"${name}" is not a command`, EXIT_USAGE, {
        hint: 'run "omni help" to see what is',
      }),
    );
  }

  const args = parseArgs(rest, {
    boolean: [...(entry.flags.boolean ?? [])],
    alias: entry.flags.alias ?? {},
  });
  if (args.errors.length > 0) {
    return done(fail(context, args.errors.join('; '), EXIT_USAGE));
  }

  const flagged = args.flags.get('actor')?.[0];
  const store = effectiveStore(baseStore, flagged ?? request.actor);
  const ready: CommandContext = {...context, store, args};

  try {
    return done(entry.run(ready));
  } catch (error) {
    // The last line of defence, and it has to honour the JSON contract like everything
    // else: an agent that asked for `--json` gets an envelope on stdout whatever went
    // wrong, never a bare stderr line it cannot parse.
    const code = isBusy(error) ? EXIT_BUSY : EXIT_ERROR;
    return done(fail(ready, describe(error), code));
  }
}

/** Lift `--json` out of argv. Anything after a bare `--` is left strictly alone. */
function liftJson(argv: readonly string[]): {json: boolean; rest: string[]} {
  let json = false;
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;
    if (token === '--') {
      rest.push(...argv.slice(i));
      break;
    }
    if (token === '--json') {
      json = true;
      continue;
    }
    rest.push(token);
  }
  return {json, rest};
}

export {EXIT_OK};
