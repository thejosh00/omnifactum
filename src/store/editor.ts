/**
 * Handing a file to `$EDITOR` and taking the terminal back afterwards.
 *
 * The app deliberately hands over the raw file rather than mediating the edit. Whatever
 * the editor writes is read back on the next scan, including fields and log entries
 * `omni` would never have written itself.
 */
import {spawnSync} from 'node:child_process';

export type EditResult =
  | {kind: 'ok'}
  | {kind: 'no-editor'}
  | {kind: 'failed'; reason: string};

export function editorCommand(env: Record<string, string | undefined>): string | undefined {
  const candidate = env['VISUAL'] ?? env['EDITOR'];
  return candidate !== undefined && candidate.trim().length > 0 ? candidate.trim() : undefined;
}

/**
 * Run the editor synchronously with the terminal handed over.
 *
 * The caller is responsible for suspending Ink first: an editor and a live render loop
 * cannot share a terminal. This is the one part of the interface that a test harness
 * cannot drive, since it needs a real pty, so it is kept to as few lines as possible.
 */
export function openInEditor(
  path: string,
  env: Record<string, string | undefined> = process.env,
): EditResult {
  const editor = editorCommand(env);
  if (editor === undefined) return {kind: 'no-editor'};

  try {
    const result = spawnSync(editor, [path], {stdio: 'inherit', shell: true});
    if (result.error !== undefined) {
      return {kind: 'failed', reason: result.error.message};
    }
    if (result.status !== 0 && result.status !== null) {
      return {kind: 'failed', reason: `${editor} exited with ${result.status}`};
    }
    return {kind: 'ok'};
  } catch (error) {
    return {kind: 'failed', reason: error instanceof Error ? error.message : String(error)};
  }
}
