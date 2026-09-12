/**
 * Checking the invariants that the rest of the app assumes, and saying which ones can
 * be repaired safely.
 *
 * Everything here is derived from the files alone, because that is the only source of
 * truth there is. Nothing in this module deletes a task: the worst it will do is
 * rewrite frontmatter the reader already had to guess at, or move a completed task
 * into the month folder its own `done:` date names.
 */
import {doneMonth} from './state.ts';
import type {Snapshot} from './snapshot.ts';
import type {TaskFile} from './types.ts';

export type FindingKind =
  | 'damaged'
  | 'needs-healing'
  | 'duplicate-id'
  | 'wrong-month'
  | 'defer-outside-someday'
  | 'unquoted-tag'
  | 'dangling-project'
  | 'missing-outcome'
  | 'stalled-project';

export interface Finding {
  kind: FindingKind;
  path: string;
  message: string;
  /** Whether `--fix` can repair this without making a judgement call. */
  fixable: boolean;
  /** What `--fix` would do, in words. */
  remedy: string;
}

export function diagnose(snapshot: Snapshot): Finding[] {
  const findings: Finding[] = [];

  for (const file of snapshot.damaged) {
    findings.push({
      kind: 'damaged',
      path: file.path,
      message: `${file.stem}: ${file.reason}`,
      fixable: false,
      // Rewriting a file we could not parse risks destroying what it says, so this one
      // is always left to a person.
      remedy: 'edit the file by hand; omni will not rewrite frontmatter it cannot read',
    });
  }

  for (const file of snapshot.tasks) {
    for (const repair of file.task.repairs) {
      switch (repair.kind) {
        case 'missing-id':
        case 'missing-title':
        case 'missing-created':
        case 'missing-done':
        case 'unparsable-frontmatter':
          findings.push({
            kind: 'needs-healing',
            path: file.path,
            message: `${file.stem}: ${repair.detail}`,
            fixable: true,
            remedy: 'write the backfilled fields into the file',
          });
          break;
        case 'done-month-mismatch':
          findings.push({
            kind: 'wrong-month',
            path: file.path,
            message: `${file.stem}: ${repair.detail}`,
            fixable: true,
            remedy: 'move the file into the month folder its done date names',
          });
          break;
        case 'defer-outside-someday':
          findings.push({
            kind: 'defer-outside-someday',
            path: file.path,
            message: `${file.stem}: ${repair.detail}`,
            // Whether the task should move to someday or lose its defer date is a
            // decision about intent, so it is reported rather than guessed at.
            fixable: false,
            remedy: `run "omni mv ${file.stem} someday", or clear the defer date`,
          });
          break;
        case 'coerced-tag':
          findings.push({
            kind: 'unquoted-tag',
            path: file.path,
            message: `${file.stem}: ${repair.detail}`,
            fixable: true,
            remedy: 'quote the tag so it reads back as text',
          });
          break;
        case 'invalid-tag':
        case 'duplicate-id':
          break;
      }
    }
  }

  // Projects get the same treatment, minus the task-only repairs.
  for (const file of snapshot.projects) {
    for (const repair of file.project.repairs) {
      if (repair.kind === 'missing-outcome') {
        findings.push({
          kind: 'missing-outcome',
          path: file.path,
          message: `${file.stem}: no outcome statement`,
          // What done looks like is the one thing the app must not invent: guessing
          // would also defeat the stalled check, which is the point of projects.
          fixable: false,
          remedy: `run "omni project outcome ${file.stem} \\"what done looks like\\""`,
        });
        continue;
      }
      if (
        repair.kind === 'missing-id' ||
        repair.kind === 'missing-title' ||
        repair.kind === 'missing-created' ||
        repair.kind === 'missing-done' ||
        repair.kind === 'unparsable-frontmatter'
      ) {
        findings.push({
          kind: 'needs-healing',
          path: file.path,
          message: `${file.stem}: ${repair.detail}`,
          fixable: true,
          remedy: 'write the backfilled fields into the file',
        });
      }
    }
  }

  // A task pointing at a project that does not exist. This is the cost of using a
  // readable stem instead of an identifier, and it is visible rather than silent.
  for (const orphan of snapshot.membership.orphans) {
    findings.push({
      kind: 'dangling-project',
      path: orphan.file.path,
      message: `${orphan.file.stem}: project "${orphan.ref}" does not exist`,
      fixable: false,
      remedy: `create it with "omni project new ..." or repoint the task's project: field`,
    });
  }

  for (const entry of snapshot.membership.projects) {
    if (!entry.stalled) continue;
    findings.push({
      kind: 'stalled-project',
      path: entry.project.path,
      message: `${entry.project.stem}: active but nothing in next or waiting moves it forward`,
      // Deciding the next action is the work itself, not a repair.
      fixable: false,
      remedy: `run "omni add \\"the next step\\" -p ${entry.project.stem} --next"`,
    });
  }

  for (const id of snapshot.duplicateIds) {
    const tasks = snapshot.tasks.filter(file => file.task.id === id);
    const projects = snapshot.projects.filter(file => file.project.id === id);
    const stems = [...tasks, ...projects].map(f => f.stem);
    findings.push({
      kind: 'duplicate-id',
      path: tasks[0]?.path ?? projects[0]?.path ?? '',
      message: `id ${id} is used by ${stems.length} files: ${stems.join(', ')}`,
      fixable: tasks.length > 1,
      remedy: 'give the newer files fresh ids',
    });
  }

  return findings;
}

/** The completed tasks filed under the wrong month, with where they belong. */
export function misfiledByMonth(snapshot: Snapshot): Array<{file: TaskFile; month: string}> {
  const out: Array<{file: TaskFile; month: string}> = [];
  for (const file of snapshot.tasks) {
    if (file.task.state !== 'done' || file.task.done === undefined) continue;
    if (!file.task.repairs.some(r => r.kind === 'done-month-mismatch')) continue;
    try {
      out.push({file, month: doneMonth(file.task.done)});
    } catch {
      // An unparsable done date is not something to act on automatically.
    }
  }
  return out;
}

/**
 * For each duplicated id, every file except the one that should keep it. The earliest
 * file by creation date keeps the id, so the original owner is not the one disturbed.
 */
export function duplicatesToRemint(snapshot: Snapshot): TaskFile[] {
  const out: TaskFile[] = [];
  for (const id of snapshot.duplicateIds) {
    const files = snapshot.tasks
      .filter(file => file.task.id === id)
      .sort((a, b) => a.task.created.localeCompare(b.task.created) || a.path.localeCompare(b.path));
    out.push(...files.slice(1));
  }
  return out;
}
