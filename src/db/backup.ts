/**
 * Backups of the database.
 *
 * There is no undo and no trash, and every task lives in one file, so a copy of that
 * file from yesterday is the only way back from a bad afternoon. The server takes one a
 * day and keeps the last fortnight.
 *
 * "A day" rather than "at 3am": a laptop is often asleep at 3am, and a job that only runs
 * then silently skips those nights. Instead each backup is named for the local date, and
 * whenever the server is running it checks whether today's exists yet.
 *
 * Copies are made with `VACUUM INTO`, which writes a consistent snapshot even while
 * other writers are busy, into a temporary name that is only renamed into place once it
 * has passed an integrity check. A file named like a backup is therefore a good one.
 */
import {existsSync, mkdirSync, readdirSync, renameSync, statSync, unlinkSync} from 'node:fs';
import {join} from 'node:path';
import {Database} from 'bun:sqlite';
import {localDate} from '../core/time.ts';

export const BACKUP_DIR = 'backups';
/** How many daily backups to keep. On-demand ones are never pruned. */
export const KEEP_DAILY = 14;

const DAILY = /^omni-(\d{4}-\d{2}-\d{2})\.db$/;
const ANY = /^omni-\d{4}-\d{2}-\d{2}(?:T\d{4})?\.db$/;

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

export function dailyName(at: Date): string {
  return `omni-${localDate(at)}.db`;
}

/** An on-demand backup, named to the minute so it never collides with a daily one. */
export function manualName(at: Date): string {
  return `omni-${localDate(at)}T${pad(at.getHours())}${pad(at.getMinutes())}.db`;
}

/** Daily backups beyond the newest `keep`, oldest first. Only daily ones are ever chosen. */
export function toPrune(names: readonly string[], keep: number): string[] {
  const daily = names.filter(name => DAILY.test(name)).sort();
  return daily.slice(0, Math.max(0, daily.length - keep));
}

export function backupDir(dataDir: string): string {
  return join(dataDir, BACKUP_DIR);
}

/** Copy the database to `dir/name`, checked, and return the path. */
export function takeBackup(db: Database, dir: string, name: string): string {
  mkdirSync(dir, {recursive: true});
  const target = join(dir, name);
  const temp = join(dir, `.${name}.partial`);
  if (existsSync(temp)) unlinkSync(temp);

  try {
    db.query('VACUUM INTO ?').run(temp);
    const copy = new Database(temp, {readonly: true});
    try {
      const result = copy.query('PRAGMA quick_check').get() as {quick_check: string} | null;
      if (result?.quick_check !== 'ok') throw new Error(`the copy failed its check: ${result?.quick_check ?? 'no answer'}`);
    } finally {
      copy.close();
    }
    renameSync(temp, target);
    return target;
  } catch (error) {
    if (existsSync(temp)) unlinkSync(temp);
    throw error;
  }
}

/**
 * Take today's backup if there is not one yet, and prune old ones. Returns the new
 * backup's path, or undefined when today's already existed.
 */
export function dailyBackup(db: Database, dataDir: string, now: Date, keep = KEEP_DAILY): string | undefined {
  const dir = backupDir(dataDir);
  const name = dailyName(now);
  if (existsSync(join(dir, name))) return undefined;

  const path = takeBackup(db, dir, name);
  for (const old of toPrune(readdirSync(dir), keep)) unlinkSync(join(dir, old));
  return path;
}

export interface BackupInfo {
  name: string;
  path: string;
  bytes: number;
  modified: Date;
  daily: boolean;
}

/** Every backup, newest first. */
export function listBackups(dataDir: string): BackupInfo[] {
  const dir = backupDir(dataDir);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter(name => ANY.test(name))
    .map(name => {
      const path = join(dir, name);
      const stat = statSync(path);
      return {name, path, bytes: stat.size, modified: stat.mtime, daily: DAILY.test(name)};
    })
    .sort((a, b) => b.modified.getTime() - a.modified.getTime());
}
