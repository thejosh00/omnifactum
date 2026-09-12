/**
 * A throwaway data directory for tests.
 *
 * Every level of the suite points the app at one of these through `OMNI_DIR`, which
 * is read in exactly one place, `src/config.ts`. Nothing else in the codebase calls
 * `os.homedir()`, so a test can never reach the real `~/.omnifactum`.
 */
import {mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {tmpdir} from 'node:os';
import {baseDirectories} from '../../src/core/state.ts';

export interface Vault {
  dir: string;
  /** Write a file into the vault at a path relative to its root. */
  put(relativePath: string, content: string): string;
  read(relativePath: string): string;
  /**
   * Every markdown file that could be a task, relative to the vault root, sorted.
   * Files at the root are excluded: a task always lives inside a state directory, so
   * `AGENTS.md` and `REVIEW.md` are documents, never tasks.
   */
  list(): string[];
  exists(relativePath: string): boolean;
  cleanup(): void;
}

export function makeVault(options: {layout?: boolean} = {}): Vault {
  const dir = mkdtempSync(join(tmpdir(), 'omni-test-'));

  if (options.layout !== false) {
    for (const relative of baseDirectories()) {
      mkdirSync(join(dir, relative), {recursive: true});
    }
  }

  return {
    dir,
    put(relativePath, content) {
      const path = join(dir, relativePath);
      mkdirSync(dirname(path), {recursive: true});
      writeFileSync(path, content);
      return path;
    },
    read(relativePath) {
      return readFileSync(join(dir, relativePath), 'utf8');
    },
    list() {
      return walk(dir, dir)
        .filter(relativePath => relativePath.includes('/'))
        .sort();
    },
    exists(relativePath) {
      try {
        readFileSync(join(dir, relativePath));
        return true;
      } catch {
        return false;
      }
    },
    cleanup() {
      rmSync(dir, {recursive: true, force: true});
    },
  };
}

function walk(root: string, current: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(current, {withFileTypes: true})) {
    const path = join(current, entry.name);
    if (entry.isDirectory()) {
      out.push(...walk(root, path));
    } else if (entry.name.endsWith('.md')) {
      out.push(path.slice(root.length + 1));
    }
  }
  return out;
}

/** A minimal, valid task file. */
export function taskFile(
  fields: {id: string; title: string; created?: string; tags?: string[]; extra?: string},
  body = '',
): string {
  const lines = [
    '---',
    `id: ${fields.id}`,
    `title: ${fields.title}`,
    `created: ${fields.created ?? '2026-09-12T10:04:00Z'}`,
  ];
  if (fields.tags !== undefined) lines.push(`tags: [${fields.tags.join(', ')}]`);
  if (fields.extra !== undefined) lines.push(fields.extra);
  lines.push('---', '');
  return `${lines.join('\n')}${body}`;
}
