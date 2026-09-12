#!/usr/bin/env bun
/**
 * The entry point.
 *
 * Its whole job is to pick a command, build the context, and set an exit code. Bare
 * `omni` opens the interactive interface; everything else runs and exits.
 */
import {parseArgs} from './core/args.ts';
import {dataDir} from './config.ts';
import {nowIso} from './core/time.ts';
import {addCommand, ADD_FLAGS} from './commands/add.ts';
import {agentsCommand, initCommand} from './commands/init.ts';
import {doctorCommand, DOCTOR_FLAGS} from './commands/doctor.ts';
import {dueCommand, listCommand, LIST_FLAGS} from './commands/list.ts';
import {editCommand, pathCommand, showCommand, tagsCommand} from './commands/inspect.ts';
import {projectCommand, PROJECT_FLAGS} from './commands/project.ts';
import {submitCommand, SUBMIT_FLAGS} from './commands/submit.ts';
import {weeklyCommand, WEEKLY_FLAGS} from './commands/weekly.ts';
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
} from './commands/modify.ts';
import {Store} from './store/store.ts';
import {LIST_STATES, type TaskState} from './core/types.ts';
import {LockTimeoutError} from './store/lock.ts';
import {
  EXIT_BUSY,
  EXIT_ERROR,
  EXIT_OK,
  EXIT_USAGE,
  describe,
  fail,
  type Command,
  type CommandContext,
} from './commands/context.ts';
import type {FlagSpec} from './core/args.ts';

export const VERSION = '0.1.0';

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
  init: {run: initCommand, flags: {}, summary: 'create the data directory and write AGENTS.md'},
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
  show: {run: showCommand, flags: {}, summary: "print a task's file"},
  path: {run: pathCommand, flags: {}, summary: 'the data directory, or one task\'s path'},
  edit: {run: editCommand, flags: {}, summary: 'open a task in $EDITOR'},
  project: {run: projectCommand, flags: PROJECT_FLAGS, summary: 'outcomes that need more than one action'},
  doctor: {run: doctorCommand, flags: DOCTOR_FLAGS, summary: 'check and repair the data'},
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
  check: 'doctor',
  projects: 'project',
  p: 'project',
};

export const COMMAND_ALIASES: Record<string, string> = ALIASES;

export function usage(): string {
  const width = Math.max(...Object.keys(COMMANDS).map(name => name.length));
  const lines = Object.entries(COMMANDS).map(
    ([name, entry]) => `  ${name.padEnd(width)}  ${entry.summary}`,
  );
  return [
    'omni — a GTD task manager whose data is plain markdown files',
    '',
    'usage: omni [command] [options]',
    '',
    'With no command, omni opens the interactive interface.',
    '',
    'commands:',
    ...lines,
    '',
    'options:',
    '  --json        machine-readable output, for agents',
    '  --actor <who> who to record in the log (or set OMNI_ACTOR)',
    '  --dir <path>  use a different data directory (or set OMNI_DIR)',
    '  -h, --help    show this',
    '  -v, --version show the version',
    '',
    'Tasks are markdown files you can read and edit directly.',
    'Run "omni agents" for the contract an AI agent should follow.',
  ].join('\n');
}

export interface RunOptions {
  argv: readonly string[];
  out: (line?: string) => void;
  err: (line?: string) => void;
  now?: () => string;
  /** Injected by the tests so the interactive path is not launched. */
  interactive?: (ctx: CommandContext) => Promise<number>;
}

export async function run(options: RunOptions): Promise<number> {
  const {argv, out, err} = options;

  // `--dir` and the help/version flags are global, so they are lifted out in one pass
  // before the command ever sees its own arguments.
  const {dir, help, version, json, rest: remaining} = liftGlobals(argv);

  if (version) {
    out(VERSION);
    return EXIT_OK;
  }

  const [name, ...rest] = remaining;
  const resolved = name === undefined ? undefined : (ALIASES[name] ?? name);

  if (help || resolved === 'help') {
    out(usage());
    return EXIT_OK;
  }

  const directory = dataDir(dir);
  const store = new Store(directory, options.now === undefined ? {} : {now: options.now});

  const context: CommandContext = {
    store,
    dataDir: directory,
    args: {positional: [], flags: new Map(), booleans: new Set(), errors: []},
    now: options.now ?? nowIso,
    out,
    err,
    json,
  };

  if (resolved === undefined) {
    const interactive = options.interactive ?? launchInteractive;
    return interactive(context);
  }

  const entry = COMMANDS[resolved];
  if (entry === undefined) {
    err(`omni: "${name}" is not a command`);
    err('run "omni help" to see what is');
    return EXIT_USAGE;
  }

  const args = parseArgs(rest, {
    boolean: [...(entry.flags.boolean ?? [])],
    alias: entry.flags.alias ?? {},
  });
  if (args.errors.length > 0) {
    for (const message of args.errors) err(`omni: ${message}`);
    return EXIT_USAGE;
  }

  const ready: CommandContext = {...context, args};

  try {
    // Every command except `init` needs the layout to exist.
    if (resolved !== 'init') store.ensureLayout();
    return entry.run(ready);
  } catch (error) {
    // The last line of defence, and it has to honour the JSON contract like everything
    // else: an agent that asked for `--json` gets an envelope on stdout whatever went
    // wrong, never a bare stderr line it cannot parse. Lock contention is reported as
    // busy here too, not only inside `runWrite` — the tickler sweep can raise it from
    // inside a command that never meant to write anything.
    const code = error instanceof LockTimeoutError ? EXIT_BUSY : EXIT_ERROR;
    if (json) return fail(ready, describe(error), code);
    err(`omni: ${describe(error)}`);
    return code;
  }
}

interface Globals {
  dir: string | undefined;
  help: boolean;
  version: boolean;
  /** Machine-readable output, for an agent rather than a person. */
  json: boolean;
  /** Everything left for the command itself. */
  rest: string[];
}

/**
 * Pull the global options out of argv in one left-to-right pass, so a value that
 * happens to repeat elsewhere on the line cannot be mistaken for one of them.
 * Anything after a bare `--` is left strictly alone.
 */
function liftGlobals(argv: readonly string[]): Globals {
  let dir: string | undefined;
  let help = false;
  let version = false;
  let json = false;
  const rest: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;

    if (token === '--') {
      rest.push(...argv.slice(i));
      break;
    }
    if (token.startsWith('--dir=')) {
      dir = token.slice('--dir='.length);
      continue;
    }
    if (token === '--dir') {
      dir = argv[i + 1];
      i += 1;
      continue;
    }
    if (token === '--help' || token === '-h') {
      help = true;
      continue;
    }
    if (token === '--version' || token === '-v') {
      version = true;
      continue;
    }
    if (token === '--json') {
      json = true;
      continue;
    }
    rest.push(token);
  }

  return {dir, help, version, json, rest};
}

async function launchInteractive(ctx: CommandContext): Promise<number> {
  // The interactive interface is loaded lazily so that a plain `omni add` never pays
  // to import React and Ink.
  const {startInteractive} = await import('./ui/start.tsx');
  return startInteractive(ctx);
}

if (import.meta.main) {
  const code = await run({
    argv: process.argv.slice(2),
    out: line => process.stdout.write(`${line ?? ''}\n`),
    err: line => process.stderr.write(`${line ?? ''}\n`),
  });
  process.exit(code);
}
