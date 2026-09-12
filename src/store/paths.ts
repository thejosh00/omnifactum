/**
 * Turning states and names into paths, and back.
 *
 * The ignore rules live here, and they are deliberately generous: anything the app
 * does not recognise is invisible to it and is never touched. A person can drop a
 * `notes.txt`, a `.git` directory, or a folder of their own into the data directory
 * and `omni` will neither adopt it nor delete it.
 */
import {basename, join, relative, sep} from 'node:path';
import {taskDir, taskStateFromDir} from '../core/state.ts';
import type {TaskLocation} from '../core/state.ts';
import type {TaskState} from '../core/types.ts';

export const MARKDOWN_EXTENSION = '.md';
export const CONTRACT_FILE = 'AGENTS.md';
export const REVIEW_FILE = 'REVIEW.md';
export const SCRATCH_DIR = '.omni';

/** Files the app owns at the top level, which are documents and never tasks. */
const TOP_LEVEL_FILES = new Set([CONTRACT_FILE, REVIEW_FILE]);

export function taskPath(
  dataDir: string,
  state: TaskState,
  stem: string,
  doneIso?: string,
): string {
  return join(dataDir, taskDir(state, doneIso), `${stem}${MARKDOWN_EXTENSION}`);
}

/** The filename stem, which is a label and never an identity. */
export function stemOf(path: string): string {
  return basename(path, MARKDOWN_EXTENSION);
}

/**
 * Whether a directory entry should be read at all. Dotfiles are skipped, which is
 * also what keeps a half-written `.omni-tmp-*` file invisible.
 */
export function isReadableEntry(name: string): boolean {
  if (name.startsWith('.')) return false;
  if (TOP_LEVEL_FILES.has(name)) return false;
  return name.toLowerCase().endsWith(MARKDOWN_EXTENSION);
}

export function isIgnoredDirectory(name: string): boolean {
  return name.startsWith('.');
}

/** The state implied by a file's location, or undefined if it is not in one. */
export function locationOf(dataDir: string, filePath: string): TaskLocation | undefined {
  const rel = relative(dataDir, filePath);
  if (rel.startsWith('..')) return undefined;
  const parts = rel.split(sep);
  parts.pop(); // the filename
  return taskStateFromDir(parts.join('/'));
}
