/**
 * Driving the CLI in tests.
 *
 * `omni` runs a command in-process against the database in the test's directory, as a
 * person, exactly as the server would run it — fast enough to use freely. `omniSpawn`
 * runs the real `src/cli.ts` in a child process against a real server over HTTP, which
 * is what proves the thing a user actually installs works, including its exit code.
 *
 * `OMNI_ACTOR` in the environment is honoured the way the client forwards it, so tests
 * written against the old local CLI keep their meaning.
 */
import {join} from 'node:path';
import type {Database} from 'bun:sqlite';
import {run} from '../../src/cli.ts';
import {runCommand} from '../../src/commands/run.ts';
import {createToken} from '../../src/db/auth.ts';
import {DB_FILE, findAccount, openDatabase} from '../../src/db/database.ts';
import {Store} from '../../src/db/store.ts';
import {startServer, type RunningServer} from '../../src/server/server.ts';

export interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface CliOptions {
  dir: string;
  /** A fixed clock, so completion months and log timestamps are predictable. */
  now?: string;
  /** Which account to act in. Defaults to work. */
  account?: string;
  /** Who the caller's token belongs to. Defaults to a person, `you`. */
  as?: string;
}

const databases = new Map<string, Database>();

/** The database for a test directory, opened once and shared by every helper. */
export function databaseFor(dir: string): Database {
  let db = databases.get(dir);
  if (db === undefined) {
    db = openDatabase(join(dir, DB_FILE));
    databases.set(dir, db);
  }
  return db;
}

export function closeDatabase(dir: string): void {
  databases.get(dir)?.close();
  databases.delete(dir);
}

export function storeFor(options: CliOptions): Store {
  const db = databaseFor(options.dir);
  const account = findAccount(db, options.account ?? 'work');
  if (account === undefined) throw new Error(`no account ${options.account}`);
  return new Store(db, account, {
    actor: options.as ?? 'you',
    ...(options.now === undefined ? {} : {now: () => options.now!}),
  });
}

const LOCAL = new Set(['serve', 'service', 'account', 'import']);

export async function omni(args: readonly string[], options: CliOptions): Promise<CliResult> {
  if (LOCAL.has(args[0] ?? '')) {
    closeDatabase(options.dir);
    const stdout: string[] = [];
    const stderr: string[] = [];
    const code = await run({
      argv: args,
      out: line => stdout.push(line ?? ''),
      err: line => stderr.push(line ?? ''),
      env: {OMNI_DIR: options.dir},
      ...(options.now === undefined ? {} : {now: () => options.now!}),
    });
    return {code, stdout: stdout.join('\n'), stderr: stderr.join('\n')};
  }

  const actor = process.env['OMNI_ACTOR']?.trim();
  const result = runCommand(storeFor(options), {
    argv: args,
    ...(actor === undefined || actor.length === 0 ? {} : {actor}),
    ...(options.now === undefined ? {} : {now: () => options.now!}),
  });
  return {code: result.code, stdout: result.stdout.join('\n'), stderr: result.stderr.join('\n')};
}

export interface TestServer {
  running: RunningServer;
  url: string;
  token(actor?: string, account?: string): string;
  stop(): Promise<void>;
}

/** A real server over the test directory's database, on a free port. */
export function serveFor(dir: string, now?: string): TestServer {
  const db = databaseFor(dir);
  const running = startServer({
    db,
    port: 0,
    hostname: '127.0.0.1',
    tickler: false,
    ...(now === undefined ? {} : {now: () => now}),
  });
  return {
    running,
    url: running.url,
    token(actor = 'you', account = 'work') {
      return createToken(db, findAccount(db, account)!.id, actor, now ?? new Date().toISOString());
    },
    stop: () => running.stop(),
  };
}

/** Run the real `src/cli.ts` as a child process against a server, the way a user would. */
export async function omniSpawn(
  args: readonly string[],
  options: {server: TestServer; token: string; env?: Record<string, string>},
): Promise<CliResult> {
  const proc = Bun.spawn(['bun', 'run', 'src/cli.ts', ...args], {
    env: {
      ...process.env,
      OMNI_URL: options.server.url,
      OMNI_TOKEN: options.token,
      NO_COLOR: '1',
      ...options.env,
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });

  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  return {code, stdout: stdout.trimEnd(), stderr: stderr.trimEnd()};
}
