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
import type {ProjectState, Task, TaskFile, TaskState} from './types.ts';

export type ChangeKind = 'completed' | 'added' | 'moved' | 'edited' | 'removed';

export interface Change {
  kind: ChangeKind;
  id: string;
  title: string;
  /** A task's state, or a project's when the change is to a project. */
  from?: TaskState | ProjectState;
  to?: TaskState | ProjectState;
  /** Who the task's newest log entry credits, e.g. `agent:claude-code`. */
  actor?: string;
  note?: string;
}

function attribution(task: Task): {actor?: string; note?: string} {
  const entry = latestEntry(task.log);
  if (entry === undefined) return {};
  const out: {actor?: string; note?: string} = {};
  if (entry.actor.length > 0) out.actor = entry.actor;
  if (entry.text.length > 0) out.note = entry.text;
  return out;
}

/**
 * What one write did to one task, or undefined if it did nothing. `before` is absent
 * for a new task and `after` for a deleted one.
 *
 * `edited` is decided by the caller, who knows whether the stored version moved.
 */
export function changeBetween(
  before: Task | undefined,
  after: Task | undefined,
  edited = true,
): Change | undefined {
  if (after === undefined) {
    if (before === undefined) return undefined;
    return {kind: 'removed', id: before.id, title: before.title, from: before.state};
  }

  if (before === undefined) {
    return {kind: 'added', id: after.id, title: after.title, to: after.state, ...attribution(after)};
  }

  if (before.state !== after.state) {
    return {
      kind: after.state === 'done' ? 'completed' : 'moved',
      id: after.id,
      title: after.title,
      from: before.state,
      to: after.state,
      ...attribution(after),
    };
  }

  if (!edited) return undefined;
  return {kind: 'edited', id: after.id, title: after.title, to: after.state, ...attribution(after)};
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
    const previous: TaskFile | undefined = before.byId.get(file.task.id);
    const change = changeBetween(
      previous?.task,
      file.task,
      previous !== undefined && previous.version !== file.version,
    );
    if (change !== undefined) changes.push(change);
  }

  for (const file of before.tasks) {
    if (!after.byId.has(file.task.id)) changes.push(changeBetween(file.task, undefined)!);
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
