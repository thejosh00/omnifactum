/**
 * A throwaway data directory for tests, holding the database.
 *
 * Tasks used to be files, and many tests say what should happen in those terms:
 * "completing it files it under done/2026-09/", "the log reads **you** — ...". Those
 * rules still hold, so `list`, `read` and `exists` show the work account's database as
 * the vault it would have been — `<state dir>/<stem>.md`, rendered as markdown — rather
 * than every test being rewritten to say the same thing another way.
 *
 * `put` still writes a real file, for the tests that build a vault to import.
 */
import {mkdtempSync, mkdirSync, rmSync, writeFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {tmpdir} from 'node:os';
import {baseDirectories} from '../../src/core/state.ts';
import {closeDatabase, storeFor} from './cli.ts';
import {projectDir, taskDir} from '../../src/core/state.ts';
import {writeTask} from '../../src/core/task.ts';
import {writeProject} from '../../src/core/project.ts';

/** The work account as a map of old-style relative paths to rendered markdown. */
function virtualFiles(dir: string): Map<string, string> {
  const snapshot = storeFor({dir}).load();
  const files = new Map<string, string>();
  for (const file of snapshot.tasks) {
    files.set(`${taskDir(file.task.state, file.task.done)}/${file.stem}.md`, writeTask(file.task, ''));
  }
  for (const file of snapshot.projects) {
    files.set(`${projectDir(file.project.state, file.project.done)}/${file.stem}.md`, writeProject(file.project, ''));
  }
  return files;
}

export interface Vault {
  dir: string;
  /** Write a real file at a path relative to the directory, for import tests. */
  put(relativePath: string, content: string): string;
  read(relativePath: string): string;
  /** Every task and project, as the path its file would have had, sorted. */
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
      const content = virtualFiles(dir).get(relativePath);
      if (content === undefined) throw new Error(`no task or project at ${relativePath}`);
      return content;
    },
    list() {
      return [...virtualFiles(dir).keys()].sort();
    },
    exists(relativePath) {
      return virtualFiles(dir).has(relativePath);
    },
    cleanup() {
      closeDatabase(dir);
      rmSync(dir, {recursive: true, force: true});
    },
  };
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
