/**
 * The exclusive lock that makes a human and agents safe to run at the same time.
 *
 * The lock exists to close one specific hole. Checking a file's mtime and then writing
 * it is two operations, so two writers can both pass the check and one loses its work.
 * Holding a lock across the whole read-modify-write cycle closes that, and because the
 * cycle re-reads inside the lock, a caller never writes against content that moved.
 *
 * **A lock only binds writers that take it.** Editing a file in vim, or an agent running
 * `mv`, bypasses this entirely — no design can prevent that, and the files are meant to
 * be hand-editable. So the mtime-and-size check in `write.ts` stays as the backstop for
 * writers from outside, and this protects everyone going through `omni`.
 *
 * The primitive is `link`, which fails with EEXIST when the target exists: the kernel
 * guarantees exactly one caller wins. The content is written to a temporary file first
 * and linked into place, so the lock file is never visible in a half-written state.
 * That detail is load-bearing — an earlier version created the file with
 * `open(..., 'wx')` and wrote to it afterwards, which left a window where a second
 * process could read an empty lock, conclude it was abandoned, and break a lock that
 * had just been taken. A lock that usually works is worse than none, because it loses
 * an update only every few dozen attempts.
 *
 * Everything else here is about not leaving a lock behind when a process dies.
 */
import {
  closeSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import {hostname} from 'node:os';
import {dirname, join} from 'node:path';

export const LOCK_FILE = join('.omni', 'lock');

export interface LockOptions {
  /** How long to wait for someone else to finish before giving up. */
  timeoutMs?: number;
  /** How long a held lock may go untouched before it is assumed abandoned. */
  staleMs?: number;
  /** How often to re-check while waiting. */
  pollMs?: number;
}

const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_STALE_MS = 30_000;
const DEFAULT_POLL_MS = 10;

export class LockTimeoutError extends Error {
  constructor(
    readonly path: string,
    readonly heldBy: LockInfo | undefined,
  ) {
    const who = heldBy === undefined ? 'another process' : `pid ${heldBy.pid} on ${heldBy.host}`;
    super(`timed out waiting for the omnifactum lock, held by ${who}`);
    this.name = 'LockTimeoutError';
  }
}

export interface LockInfo {
  pid: number;
  host: string;
  /** When the lock was taken, in epoch milliseconds. */
  at: number;
}

/** A sleep that blocks, because the store is synchronous all the way down. */
function sleepSync(ms: number): void {
  // Atomics.wait on a throwaway buffer is the portable synchronous sleep. It works
  // under both Bun and Node, unlike a busy loop, which would burn a core while waiting.
  const buffer = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(buffer, 0, 0, ms);
}

function readLockInfo(path: string): LockInfo | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (typeof parsed !== 'object' || parsed === null) return undefined;
    const {pid, host, at} = parsed as Partial<LockInfo>;
    if (typeof pid !== 'number' || typeof host !== 'string' || typeof at !== 'number') {
      return undefined;
    }
    return {pid, host, at};
  } catch {
    // Unreadable or half-written: treat as unknown, and let the age check decide.
    return undefined;
  }
}

function processAlive(pid: number): boolean {
  try {
    // Signal 0 checks for existence without touching the process.
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means it exists and belongs to someone else, which still counts as alive.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Whether a held lock should be broken.
 *
 * `fallbackAgeMs` is how old the lock *file* is, used when its contents cannot be read.
 * That case is not hypothetical: it is the window between a lock file being created and
 * being written to. Treating unreadable as abandoned would let a second process break a
 * lock that had just been taken, which is worse than any lock at all — it looks like it
 * works and loses an update every few dozen attempts.
 */
export function isStale(
  info: LockInfo | undefined,
  nowMs: number,
  staleMs: number,
  fallbackAgeMs?: number,
): boolean {
  if (info === undefined) {
    // Unreadable. Judge it by age alone, and only break it once it is properly old.
    return fallbackAgeMs !== undefined && fallbackAgeMs > staleMs;
  }
  if (nowMs - info.at > staleMs) return true;
  // A pid is only meaningful on the machine that wrote it.
  if (info.host === hostname() && !processAlive(info.pid)) return true;
  return false;
}

function ageOf(path: string): number | undefined {
  try {
    return Date.now() - statSync(path).mtimeMs;
  } catch {
    return undefined;
  }
}

/**
 * Break a lock that looks abandoned.
 *
 * Renaming first is what makes this safe: two processes can both decide to break the
 * same lock, but `rename` is atomic, so only one of them succeeds and the other simply
 * goes back to waiting.
 */
function breakLock(path: string): void {
  const aside = `${path}.broken-${process.pid}-${Date.now()}`;
  try {
    renameSync(path, aside);
    unlinkSync(aside);
  } catch {
    // Someone else broke it, or it was released normally. Either way, retry.
  }
}

export interface Held {
  release(): void;
}

export function acquireLock(dataDir: string, options: LockOptions = {}): Held {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const staleMs = options.staleMs ?? DEFAULT_STALE_MS;
  const pollMs = options.pollMs ?? DEFAULT_POLL_MS;

  const path = join(dataDir, LOCK_FILE);
  mkdirSync(dirname(path), {recursive: true});

  const deadline = Date.now() + timeoutMs;
  let lastSeen: LockInfo | undefined;

  const release = (): void => {
    try {
      unlinkSync(path);
    } catch {
      // Already gone, most likely broken as stale. Nothing to undo.
    }
  };

  for (;;) {
    if (publish(path, {pid: process.pid, host: hostname(), at: Date.now()})) {
      return {release};
    }

    lastSeen = readLockInfo(path);
    if (isStale(lastSeen, Date.now(), staleMs, ageOf(path))) {
      breakLock(path);
      continue;
    }

    if (Date.now() >= deadline) throw new LockTimeoutError(path, lastSeen);
    sleepSync(pollMs);
  }
}

/**
 * Make the lock file appear, complete, in one step. Returns false if someone holds it.
 *
 * The content is written to a temporary file first and then hard-linked into place.
 * `link` fails with EEXIST when the target exists, so it is just as exclusive as
 * `open(..., 'wx')`, but the file is never observable in a half-written state — which
 * is the window that made an empty lock look abandoned.
 */
function publish(path: string, info: LockInfo): boolean {
  const temp = `${path}.claim-${process.pid}-${Math.random().toString(36).slice(2, 10)}`;
  const fd = openSync(temp, 'wx');
  try {
    writeSync(fd, JSON.stringify(info));
  } finally {
    closeSync(fd);
  }

  try {
    linkSync(temp, path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    return false;
  } finally {
    try {
      unlinkSync(temp);
    } catch {
      // The sweep in `doctor` would get it; it is a dotfile either way.
    }
  }
}

/**
 * Run something with the lock held, releasing it however the callback ends.
 *
 * Re-entrant: a mutation that internally does another mutation would otherwise
 * deadlock against itself, which is a very confusing way to hang.
 */
let depth = 0;

export function withLock<T>(dataDir: string, action: () => T, options: LockOptions = {}): T {
  if (depth > 0) {
    depth += 1;
    try {
      return action();
    } finally {
      depth -= 1;
    }
  }

  const held = acquireLock(dataDir, options);
  depth = 1;
  try {
    return action();
  } finally {
    depth = 0;
    held.release();
  }
}

/** Whether this process currently holds the lock. For assertions and tests. */
export function holdingLock(): boolean {
  return depth > 0;
}
