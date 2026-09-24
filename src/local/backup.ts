/**
 * `omni backup`: take a backup now, or see which exist.
 *
 * The server already takes one a day; this is for the moment before something drastic —
 * a big import, a bulk clean-up — when you want a copy you can point at. On-demand
 * backups are named to the minute and are never pruned.
 */
import {parseArgs} from '../core/args.ts';
import {renderJson} from '../core/serialize.ts';
import {backupDir, KEEP_DAILY, listBackups, manualName, takeBackup} from '../db/backup.ts';
import {EXIT_ERROR, EXIT_OK, EXIT_USAGE} from '../commands/context.ts';
import type {LocalContext} from './account.ts';

function size(bytes: number): string {
  return bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function backupCommand(ctx: LocalContext, argv: readonly string[]): number {
  const [sub] = parseArgs(argv).positional;

  if (sub === 'list') {
    const backups = listBackups(ctx.dataDir);
    if (ctx.json) {
      ctx.out(
        renderJson(
          backups.map(b => ({name: b.name, path: b.path, bytes: b.bytes, modified: b.modified.toISOString(), daily: b.daily})),
        ),
      );
      return EXIT_OK;
    }
    if (backups.length === 0) {
      ctx.out('No backups yet. The server takes one a day; "omni backup" takes one now.');
      return EXIT_OK;
    }
    ctx.out(`in ${backupDir(ctx.dataDir)}  (the last ${KEEP_DAILY} daily ones are kept)`);
    for (const b of backups) {
      ctx.out(`  ${b.name.padEnd(26)}  ${size(b.bytes).padStart(7)}  ${b.daily ? 'daily' : 'on demand'}`);
    }
    return EXIT_OK;
  }

  if (sub !== undefined) {
    ctx.err('usage: omni backup [list]');
    return EXIT_USAGE;
  }

  try {
    const path = takeBackup(ctx.db, backupDir(ctx.dataDir), manualName(new Date(ctx.now())));
    if (ctx.json) ctx.out(renderJson({ok: true, path}));
    else ctx.out(`backed up to ${path}`);
    return EXIT_OK;
  } catch (error) {
    const message = `backup failed: ${error instanceof Error ? error.message : String(error)}`;
    if (ctx.json) ctx.out(renderJson({ok: false, error: message, code: EXIT_ERROR}));
    else ctx.err(message);
    return EXIT_ERROR;
  }
}
