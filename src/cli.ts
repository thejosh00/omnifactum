#!/usr/bin/env bun
/**
 * The entry point.
 *
 * Three commands run here, on this machine, against the database file: `serve` starts
 * the server, `account` hands out tokens, and `import` brings in a markdown vault.
 * Everything else is sent to the server, which runs it against your account and sends
 * back what to print and the exit code. That is what lets an agent on another machine
 * use exactly the same commands, and what keeps a person in the browser and an agent at
 * a shell from overwriting each other: there is one writer, and it is the server.
 */
import {networkInterfaces} from 'node:os';
import {join} from 'node:path';
import {homedir} from 'node:os';
import {resolveDataDir} from './config.ts';
import {flagValue, hasFlag, parseArgs} from './core/args.ts';
import {nowIso} from './core/time.ts';
import {renderJson, failure} from './core/serialize.ts';
import {clientConfig, runRemote, Unauthorized, Unreachable, type Fetch} from './client.ts';
import {EXIT_BUSY, EXIT_OK, EXIT_USAGE} from './commands/context.ts';
import {COMMAND_ALIASES, commandSummaries} from './commands/run.ts';
import {DB_FILE, openDatabase} from './db/database.ts';
import {accountCommand, type LocalContext} from './local/account.ts';
import {importCommand} from './local/import.ts';
import {serviceCommand} from './local/service.ts';

export const VERSION = '0.2.0';

export {COMMAND_NAMES, COMMAND_ALIASES} from './commands/run.ts';

/** The commands that run on this machine rather than on the server. */
export const LOCAL_COMMAND_NAMES = ['serve', 'service', 'account', 'import'];

const LOCAL_COMMANDS: Array<[string, string]> = [
  ['serve', 'start the server and the web app'],
  ['service', 'keep the server running in the background (macOS)'],
  ['account', 'accounts, PINs, and tokens for the CLI and agents'],
  ['import', 'bring a markdown vault into an account'],
];

export function usage(): string {
  const all = [...LOCAL_COMMANDS, ...commandSummaries()];
  const width = Math.max(...all.map(([name]) => name.length));
  return [
    'omni — a GTD task manager with a web app, a command line, and an API for agents',
    '',
    'usage: omni [command] [options]',
    '',
    'on this machine:',
    ...LOCAL_COMMANDS.map(([name, summary]) => `  ${name.padEnd(width)}  ${summary}`),
    '',
    'against the server:',
    ...commandSummaries().map(([name, summary]) => `  ${name.padEnd(width)}  ${summary}`),
    '',
    'options:',
    '  --json        machine-readable output, for agents',
    '  --actor <who> who to record in the log (or set OMNI_ACTOR)',
    '  --dir <path>  where the database lives (or set OMNI_DIR)',
    '  -h, --help    show this',
    '  -v, --version show the version',
    '',
    'environment:',
    '  OMNI_URL      the server, default http://127.0.0.1:7777',
    '  OMNI_TOKEN    your token; see "omni account token"',
    '',
    'Run "omni agents" for the contract an AI agent should follow.',
  ].join('\n');
}

export interface RunOptions {
  argv: readonly string[];
  out: (line?: string) => void;
  err: (line?: string) => void;
  now?: () => string;
  env?: Record<string, string | undefined>;
  fetch?: Fetch;
  /** Injected by tests so `serve` does not block. */
  serve?: (options: ServeRequest) => Promise<number>;
}

export interface ServeRequest {
  dbPath: string;
  hostname: string;
  port: number;
  development: boolean;
  out: (line?: string) => void;
}

export async function run(options: RunOptions): Promise<number> {
  const {argv, out, err} = options;
  const env = options.env ?? process.env;
  const now = options.now ?? nowIso;
  const {dir, help, version, json, rest: remaining} = liftGlobals(argv);

  if (version) {
    out(VERSION);
    return EXIT_OK;
  }

  const [name, ...rest] = remaining;
  const resolved = name === undefined ? undefined : (COMMAND_ALIASES[name] ?? name);

  if (help || resolved === 'help' || resolved === undefined) {
    out(usage());
    return EXIT_OK;
  }

  const directory = dataDirFrom(env, dir);

  if (resolved === 'serve') {
    const args = parseArgs(rest, {boolean: ['dev'], alias: {p: 'port', H: 'host'}});
    const request: ServeRequest = {
      dbPath: join(directory, DB_FILE),
      hostname: flagValue(args, 'host') ?? env['OMNI_HOST'] ?? '0.0.0.0',
      port: Number(flagValue(args, 'port') ?? env['OMNI_PORT'] ?? 7777),
      development: hasFlag(args, 'dev'),
      out,
    };
    if (!Number.isInteger(request.port)) {
      err('omni: --port must be a number');
      return EXIT_USAGE;
    }
    return (options.serve ?? serve)(request);
  }

  if (resolved === 'service') {
    return serviceCommand({dataDir: directory, out, err}, rest);
  }

  if (resolved === 'account' || resolved === 'import') {
    const db = openDatabase(join(directory, DB_FILE));
    try {
      const ctx: LocalContext = {db, dataDir: directory, now, json, out, err};
      return resolved === 'account' ? accountCommand(ctx, rest) : importCommand(ctx, rest);
    } finally {
      db.close();
    }
  }

  // Everything else runs on the server. `--json` goes along so it can shape the output.
  const config = clientConfig(env, directory);
  const forwarded = json ? [...remaining, '--json'] : remaining;
  const actor = env['OMNI_ACTOR']?.trim() || undefined;

  const report = (message: string, hint: string, code: number) => {
    if (json) out(renderJson(failure(message, code, {hint})));
    else {
      err(`omni: ${message}`);
      err(hint);
    }
    return code;
  };

  try {
    const result = await runRemote(config, forwarded, actor, options.fetch);
    for (const line of result.stdout) out(line);
    for (const line of result.stderr) err(line);
    return result.code;
  } catch (error) {
    if (error instanceof Unauthorized) {
      return report(
        config.token === undefined ? 'no token: this machine has not been given one' : 'the server did not accept this token',
        'on the server machine run: omni account token <work|home> you --save   (or set OMNI_TOKEN)',
        EXIT_USAGE,
      );
    }
    if (error instanceof Unreachable) {
      return report(
        `cannot reach the omni server at ${config.url}`,
        'start it with "omni serve", or point OMNI_URL at it',
        EXIT_BUSY,
      );
    }
    throw error;
  }
}

/** The data directory, from the same environment everything else here reads. */
function dataDirFrom(env: Record<string, string | undefined>, flag: string | undefined): string {
  return resolveDataDir({flag, env, home: homedir(), cwd: process.cwd()});
}

async function serve(request: ServeRequest): Promise<number> {
  const {startServer} = await import('./server/server.ts');
  const db = openDatabase(request.dbPath);
  const running = startServer({db, hostname: request.hostname, port: request.port, development: request.development});

  request.out(`omni is serving ${request.dbPath}`);
  request.out(`  on this machine:  http://localhost:${running.server.port}`);
  if (request.hostname === '0.0.0.0') {
    for (const address of lanAddresses()) request.out(`  on your network:  http://${address}:${running.server.port}`);
  }

  // Runs until interrupted.
  await new Promise<void>(resolve => {
    const stop = () => resolve();
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  });
  await running.stop();
  db.close();
  return EXIT_OK;
}

function lanAddresses(): string[] {
  const out: string[] = [];
  for (const list of Object.values(networkInterfaces())) {
    for (const entry of list ?? []) {
      if (entry.family === 'IPv4' && !entry.internal) out.push(entry.address);
    }
  }
  return out;
}

interface Globals {
  dir: string | undefined;
  help: boolean;
  version: boolean;
  json: boolean;
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

if (import.meta.main) {
  const code = await run({
    argv: process.argv.slice(2),
    out: line => process.stdout.write(`${line ?? ''}\n`),
    err: line => process.stderr.write(`${line ?? ''}\n`),
  });
  process.exit(code);
}
