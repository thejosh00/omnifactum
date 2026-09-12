/**
 * Where the data lives.
 *
 * This is the only module in the codebase that calls `os.homedir()`. Everything else
 * asks for the data directory, which is what lets every test at every level point the
 * whole app at a fresh temporary directory by setting one environment variable.
 */
import {homedir} from 'node:os';
import {isAbsolute, resolve} from 'node:path';

export const DATA_DIR_ENV = 'OMNI_DIR';
export const DEFAULT_DIR_NAME = '.omnifactum';

export interface ResolveOptions {
  /** From `--dir`, which beats everything. */
  flag?: string | undefined;
  env: Record<string, string | undefined>;
  home: string;
  /** For turning a relative `--dir` into an absolute path. */
  cwd: string;
}

/**
 * Pure, so the precedence rules are testable without touching the environment:
 * `--dir`, then `OMNI_DIR`, then `~/.omnifactum`.
 */
export function resolveDataDir(options: ResolveOptions): string {
  const {flag, env, home, cwd} = options;

  const chosen = firstNonEmpty(flag, env[DATA_DIR_ENV]);
  if (chosen === undefined) return resolve(home, DEFAULT_DIR_NAME);

  const expanded = expandHome(chosen, home);
  return isAbsolute(expanded) ? resolve(expanded) : resolve(cwd, expanded);
}

function firstNonEmpty(...values: Array<string | undefined>): string | undefined {
  for (const value of values) {
    if (value !== undefined && value.trim().length > 0) return value.trim();
  }
  return undefined;
}

function expandHome(path: string, home: string): string {
  if (path === '~') return home;
  if (path.startsWith('~/')) return resolve(home, path.slice(2));
  return path;
}

/** The data directory for this process. */
export function dataDir(flag?: string): string {
  return resolveDataDir({
    flag,
    env: process.env,
    home: homedir(),
    cwd: process.cwd(),
  });
}
