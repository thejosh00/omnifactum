/**
 * Working out what someone else changed, so the interface can say so.
 *
 * When an agent completes a task while you are looking at the list, the row simply
 * disappearing is not good enough: you are left wondering whether you did something.
 * This compares two snapshots and produces a sentence naming what happened and who did
 * it, which is the whole reason tasks carry an actor in their log.
 *
 * Pure, so every shape below is an ordinary test rather than something to discover by
 * running two terminals side by side.
 */
import {latestEntry} from './log.ts';
import type {Snapshot} from './snapshot.ts';
import type {TaskFile, TaskState} from './types.ts';

export type ChangeKind = 'completed' | 'added' | 'moved' | 'edited' | 'removed';

export interface Change {
  kind: ChangeKind;
  id: string;
  title: string;
  from?: TaskState;
  to?: TaskState;
  /** Who the task's newest log entry credits, e.g. `agent:claude-code`. */
  actor?: string;
  note?: string;
}

function attribution(file: TaskFile): {actor?: string; note?: string} {
  const entry = latestEntry(file.task.log);
  if (entry === undefined) return {};
  const out: {actor?: string; note?: string} = {};
  if (entry.actor.length > 0) out.actor = entry.actor;
  if (entry.text.length > 0) out.note = entry.text;
  return out;
}

/**
 * What changed between two snapshots, in a stable order.
 *
 * Only changes made by someone else reach here: the interface refreshes after its own
 * writes without going through this.
 */
export function diffSnapshots(before: Snapshot, after: Snapshot): Change[] {
  const changes: Change[] = [];

  for (const file of after.tasks) {
    const previous = before.byId.get(file.task.id);

    if (previous === undefined) {
      changes.push({
        kind: 'added',
        id: file.task.id,
        title: file.task.title,
        to: file.task.state,
        ...attribution(file),
      });
      continue;
    }

    if (previous.task.state !== file.task.state) {
      changes.push({
        kind: file.task.state === 'done' ? 'completed' : 'moved',
        id: file.task.id,
        title: file.task.title,
        from: previous.task.state,
        to: file.task.state,
        ...attribution(file),
      });
      continue;
    }

    if (previous.mtimeMs !== file.mtimeMs || previous.size !== file.size) {
      changes.push({
        kind: 'edited',
        id: file.task.id,
        title: file.task.title,
        to: file.task.state,
        ...attribution(file),
      });
    }
  }

  for (const file of before.tasks) {
    if (!after.byId.has(file.task.id)) {
      changes.push({
        kind: 'removed',
        id: file.task.id,
        title: file.task.title,
        from: file.task.state,
      });
    }
  }

  return changes;
}

function by(change: Change): string {
  return change.actor === undefined || change.actor === 'you' ? '' : ` by ${change.actor}`;
}

/** One change, as a sentence. */
export function describeChange(change: Change): string {
  switch (change.kind) {
    case 'completed':
      return `"${change.title}" was completed${by(change)}`;
    case 'moved':
      return `"${change.title}" moved to ${change.to}${by(change)}`;
    case 'added':
      return `"${change.title}" was added${by(change)}`;
    case 'edited':
      return `"${change.title}" was edited${by(change)}`;
    case 'removed':
      return `"${change.title}" was deleted`;
  }
}

/**
 * A one-line summary for the banner. A single change is named in full, including the
 * note if there is one, since that is the interesting part. Several are counted.
 */
export function describeChanges(changes: readonly Change[]): string | undefined {
  if (changes.length === 0) return undefined;

  if (changes.length === 1) {
    const only = changes[0]!;
    const sentence = describeChange(only);
    return only.note === undefined ? sentence : `${sentence}: ${only.note}`;
  }

  const completed = changes.filter(c => c.kind === 'completed').length;
  if (completed === changes.length) return `${completed} tasks were completed elsewhere`;

  return `${changes.length} tasks changed elsewhere`;
}
