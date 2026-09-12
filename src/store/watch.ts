/**
 * Noticing that the data directory changed underneath us.
 *
 * The watcher is a convenience and never a correctness mechanism. Correctness comes
 * from `write.ts`, where every write re-checks the file's mtime and size immediately
 * before touching it. The watcher being late, missing an event, or being switched off
 * entirely changes nothing about safety — it only changes how quickly the screen
 * catches up.
 *
 * Two things make it behave. Events are debounced, because a single save can produce
 * several. And paths the app just wrote are suppressed, because otherwise the app's own
 * writes would trigger a reload, which would re-render, which under a held-down key
 * becomes a feedback loop that looks like flicker.
 */
import {watch, type FSWatcher} from 'node:fs';

export interface Watcher {
  close(): void;
  /** Ignore the next change to this path, because we caused it. */
  suppress(path: string): void;
  /** Whether a real filesystem watch is running, as opposed to nothing. */
  readonly active: boolean;
}

export interface WatchOptions {
  /** How long to wait for the flurry of events from one save to settle. */
  debounceMs?: number;
  /** How long a suppressed path stays suppressed. */
  suppressMs?: number;
  /** Set OMNI_NO_WATCH=1 to turn the watcher off entirely. */
  enabled?: boolean;
}

const DEFAULT_DEBOUNCE_MS = 150;
const DEFAULT_SUPPRESS_MS = 750;

export function watchDataDir(
  dataDir: string,
  onChange: () => void,
  options: WatchOptions = {},
): Watcher {
  const debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  const suppressMs = options.suppressMs ?? DEFAULT_SUPPRESS_MS;
  const enabled = options.enabled ?? true;

  const suppressed = new Map<string, number>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let watcher: FSWatcher | undefined;
  let closed = false;

  const isSuppressed = (filename: string | null): boolean => {
    if (filename === null) return false;
    const now = Date.now();

    // Opportunistically drop stale entries, so the map cannot grow without bound.
    for (const [path, until] of suppressed) {
      if (until <= now) suppressed.delete(path);
    }

    for (const [path, until] of suppressed) {
      if (until > now && path.endsWith(filename)) return true;
    }
    return false;
  };

  const schedule = (): void => {
    if (closed) return;
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      if (!closed) onChange();
    }, debounceMs);
  };

  if (enabled) {
    try {
      watcher = watch(dataDir, {recursive: true}, (_event, filename) => {
        if (isSuppressed(filename)) return;
        schedule();
      });
      // A watcher that dies should not take the interface down with it.
      watcher.on('error', () => {
        watcher?.close();
        watcher = undefined;
      });
    } catch {
      // Recursive watching is not available everywhere. The interface still works;
      // `r` rereads on demand.
      watcher = undefined;
    }
  }

  return {
    get active() {
      return watcher !== undefined;
    },
    suppress(path: string) {
      suppressed.set(path, Date.now() + suppressMs);
    },
    close() {
      closed = true;
      if (timer !== undefined) clearTimeout(timer);
      watcher?.close();
      watcher = undefined;
    },
  };
}
