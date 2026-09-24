/**
 * `omni import <dir> --account <name>`: bring a markdown vault into the database.
 *
 * This is the old file store's reader, kept for exactly this. Ids, titles, logs,
 * filename stems and project links all come across unchanged, so an agent holding a
 * task id from before the move still finds the same task.
 *
 * Importing never deletes or edits a file; the vault is left exactly as it was. A task
 * whose id is already in the account is skipped and reported rather than overwritten,
 * which makes running it twice harmless.
 */
import {existsSync, readFileSync} from 'node:fs';
import {join} from 'node:path';
import {parseArgs, flagValue} from '../core/args.ts';
import {renderJson} from '../core/serialize.ts';
import {findAccount} from '../db/database.ts';
import {Store} from '../db/store.ts';
import {scan} from '../store/scan.ts';
import {EXIT_ERROR, EXIT_NOT_FOUND, EXIT_OK, EXIT_USAGE} from '../commands/context.ts';
import type {LocalContext} from './account.ts';

const REVIEW_FILE = 'REVIEW.md';

export function importCommand(ctx: LocalContext, argv: readonly string[]): number {
  const args = parseArgs(argv, {alias: {a: 'account'}});
  const [dir] = args.positional;
  const accountName = flagValue(args, 'account');
  const fail = (message: string, code: number) => {
    if (ctx.json) ctx.out(renderJson({ok: false, error: message, code}));
    else ctx.err(message);
    return code;
  };

  if (dir === undefined || accountName === undefined) {
    return fail('usage: omni import <vault directory> --account <name>', EXIT_USAGE);
  }
  if (!existsSync(dir)) return fail(`${dir} does not exist`, EXIT_NOT_FOUND);
  const account = findAccount(ctx.db, accountName);
  if (account === undefined) return fail(`no account named "${accountName}"`, EXIT_NOT_FOUND);

  // Recorded as the app, not as you: nobody did anything to these tasks today.
  const store = new Store(ctx.db, account, {actor: 'omni', now: ctx.now});
  const found = scan(dir, {nowIso: ctx.now()});

  const skipped: string[] = [];
  let tasks = 0;
  let projects = 0;

  store.batch(() => {
    for (const file of found.projects) {
      const result = store.importProject({...file.project, repairs: []}, file.stem);
      if (result.kind === 'ok') projects += 1;
      else skipped.push(`${file.path}: ${result.kind === 'failed' ? result.reason : result.kind}`);
    }
    for (const file of found.tasks) {
      const result = store.importTask({...file.task, repairs: []}, file.stem);
      if (result.kind === 'ok') tasks += 1;
      else skipped.push(`${file.path}: ${result.kind === 'failed' ? result.reason : result.kind}`);
    }

    const reviewPath = join(dir, REVIEW_FILE);
    if (existsSync(reviewPath) && store.readDocument(REVIEW_FILE) === undefined) {
      store.writeDocument(REVIEW_FILE, readFileSync(reviewPath, 'utf8'));
    }
  });

  const damaged = found.damaged.map(file => `${file.path}: ${file.reason}`);

  if (ctx.json) {
    ctx.out(renderJson({ok: true, account: account.name, tasks, projects, skipped, damaged}));
  } else {
    ctx.out(`imported ${tasks} tasks and ${projects} projects into ${account.name}`);
    if (skipped.length > 0) {
      ctx.err(`skipped ${skipped.length}:`);
      for (const line of skipped) ctx.err(`  ${line}`);
    }
    if (damaged.length > 0) {
      ctx.err(`could not read ${damaged.length}:`);
      for (const line of damaged) ctx.err(`  ${line}`);
    }
  }
  return damaged.length > 0 && tasks === 0 ? EXIT_ERROR : EXIT_OK;
}
