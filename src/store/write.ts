/**
 * Every byte the app writes goes through this module.
 *
 * **Atomic write.** Content goes to a temporary file in the *same directory*, is
 * fsynced, and is then renamed over the target. Same directory means same filesystem,
 * which is what makes the rename atomic. The temp file is a dotfile so the scanner
 * cannot see a half-written file.
 *
 * **Atomic move.** A state change is a single rename between directories under one
 * root, so it is atomic too.
 *
 * **Order matters when completing a task.** Completion is both a content change and a
 * move, and the content is written first. A crash in between then leaves one file, in
 * its old directory, whose log says it is done — visible, valid, and easy to finish by
 * hand. The other order can leave the same id in two directories, which breaks the
 * rule that the directory is the state and forces a dedupe rule onto every reader,
 * including agents. A cosmetic wobble is better than a corrupted model.
 *
 * **Concurrency, honestly.** There is no locking, by decision. Every read records the
 * file's mtime and size, and every write re-checks them immediately beforehand and
 * refuses to clobber a file that moved underneath it. The residual failure is that
 * `stat` and `write` are not one operation, so a writer landing inside that
 * sub-millisecond window is lost. Nothing short of a lock fixes that. What makes it
 * benign is that the window is tiny, the app never holds a stale buffer, and whenever
 * the check does fire the losing content is preserved under `.omni/conflicts/`.
 */
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import {basename, dirname, join} from 'node:path';

/** The prefix for in-progress writes. A dotfile, so the scanner ignores it. */
export const TEMP_PREFIX = '.omni-tmp-';

export interface Stamp {
  mtimeMs: number;
  size: number;
}

export function stampOf(path: string): Stamp | undefined {
  try {
    const stat = statSync(path);
    return {mtimeMs: stat.mtimeMs, size: stat.size};
  } catch {
    return undefined;
  }
}

export class StaleWriteError extends Error {
  constructor(
    readonly path: string,
    readonly expected: Stamp | undefined,
    readonly found: Stamp | undefined,
  ) {
    super(`${basename(path)} changed on disk since it was read`);
    this.name = 'StaleWriteError';
  }
}

function sameStamp(a: Stamp | undefined, b: Stamp | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  return a.mtimeMs === b.mtimeMs && a.size === b.size;
}

export interface AtomicWriteOptions {
  /**
   * The stamp the content was read from. The write is refused if the file no longer
   * matches. Pass undefined to assert the file does not exist yet.
   */
  expect?: Stamp | undefined;
  /** Skip the staleness check. Used only for files the app alone owns. */
  force?: boolean;
}

/** Write a file atomically. Returns the stamp of the file just written. */
export function atomicWrite(path: string, content: string, options: AtomicWriteOptions = {}): Stamp {
  const dir = dirname(path);
  mkdirSync(dir, {recursive: true});

  if (options.force !== true) {
    const found = stampOf(path);
    if (!sameStamp(options.expect, found)) {
      throw new StaleWriteError(path, options.expect, found);
    }
  }

  const temp = join(dir, `${TEMP_PREFIX}${process.pid}-${Math.random().toString(36).slice(2, 10)}`);
  const fd = openSync(temp, 'wx');
  try {
    writeSync(fd, content);
    // fsync before the rename, so a crash cannot leave the target pointing at
    // content that never reached the disk.
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }

  try {
    renameSync(temp, path);
  } catch (error) {
    try {
      unlinkSync(temp);
    } catch {
      // The sweep in `doctor` will get it.
    }
    throw error;
  }

  return stampOf(path) ?? {mtimeMs: Date.now(), size: content.length};
}

/**
 * Move a file, resolving a destination-name collision first so the rename itself
 * cannot fail for that reason. Returns the path actually used.
 */
export function atomicMove(from: string, to: string): string {
  mkdirSync(dirname(to), {recursive: true});
  const destination = to === from ? to : freePath(to);
  renameSync(from, destination);
  return destination;
}

/** The given path, or the first `-2`, `-3` variant that is free. */
export function freePath(path: string): string {
  if (!existsSync(path)) return path;

  const dir = dirname(path);
  const name = basename(path);
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const extension = dot > 0 ? name.slice(dot) : '';

  for (let n = 2; ; n++) {
    const candidate = join(dir, `${stem}-${n}${extension}`);
    if (!existsSync(candidate)) return candidate;
  }
}

/**
 * Preserve content the app is about to lose, under `.omni/conflicts/`.
 *
 * This is not a trash bucket and it is not an undo. It holds bytes only when the app
 * would otherwise destroy someone else's write by accident. Things deleted on purpose
 * are deleted.
 */
export function backupConflict(dataDir: string, name: string, content: string, nowIso: string): string {
  const stamp = nowIso.replace(/[:.]/g, '-');
  const path = freePath(join(dataDir, '.omni', 'conflicts', `${stamp}-${name}`));
  mkdirSync(dirname(path), {recursive: true});
  writeFileSync(path, content);
  return path;
}

/** Delete a file. Deliberate deletions are real, by decision; there is no trash. */
export function deleteFile(path: string): void {
  rmSync(path, {force: true});
}

/**
 * Remove temp files left behind by a crash. Anything younger than the cutoff is left
 * alone, since it may belong to a write happening right now in another process.
 */
export function sweepTempFiles(dir: string, olderThanMs: number, nowMs: number): string[] {
  const swept: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return swept;
  }

  for (const entry of entries) {
    if (!entry.startsWith(TEMP_PREFIX)) continue;
    const path = join(dir, entry);
    const stamp = stampOf(path);
    if (stamp === undefined || nowMs - stamp.mtimeMs < olderThanMs) continue;
    try {
      unlinkSync(path);
      swept.push(path);
    } catch {
      // Someone else got there first, which is fine.
    }
  }
  return swept;
}
