/**
 * A whole-world view, built from whatever the scan found.
 *
 * The snapshot is derived, disposable, and correct to throw away at any moment. That
 * is deliberate: agents edit files behind the app's back, so the only safe cache is
 * one that can be rebuilt from the files in its entirety. A personal task system holds
 * hundreds of files, which makes rebuilding cheap enough to prefer over any incremental
 * scheme that could drift.
 */
import {membershipOf} from './stalled.ts';
import {tagIndex} from './tags.ts';
import {TASK_STATES} from './types.ts';
import type {MembershipReport, ProjectMembership} from './stalled.ts';
import type {DamagedFile, ProjectFile, TaskFile, TaskState} from './types.ts';
import type {TagUse} from './tags.ts';

export interface Snapshot {
  tasks: TaskFile[];
  projects: ProjectFile[];
  byId: Map<string, TaskFile>;
  byState: Map<TaskState, TaskFile[]>;
  tags: TagUse[];
  damaged: DamagedFile[];
  /** Ids carried by more than one file. Reported by `doctor`, which can re-mint. */
  duplicateIds: string[];
  /** Files whose reading had to backfill something, so they are worth rewriting. */
  needHealing: TaskFile[];
  projectsNeedHealing: ProjectFile[];
  /** Which projects are moving, which have stalled, and which links dangle. */
  membership: MembershipReport;
}

export function buildSnapshot(
  tasks: TaskFile[],
  projects: ProjectFile[],
  damaged: DamagedFile[] = [],
): Snapshot {
  const byId = new Map<string, TaskFile>();
  const seen = new Map<string, number>();
  const byState = new Map<TaskState, TaskFile[]>();
  for (const state of TASK_STATES) byState.set(state, []);

  for (const file of tasks) {
    seen.set(file.task.id, (seen.get(file.task.id) ?? 0) + 1);
    // First writer wins, so lookups are stable while duplicates are reported.
    if (!byId.has(file.task.id)) byId.set(file.task.id, file);
    byState.get(file.task.state)!.push(file);
  }
  for (const file of projects) {
    seen.set(file.project.id, (seen.get(file.project.id) ?? 0) + 1);
  }

  const duplicateIds = [...seen.entries()]
    .filter(([, count]) => count > 1)
    .map(([id]) => id)
    .sort();

  return {
    tasks,
    projects,
    byId,
    byState,
    tags: tagIndex(tasks.map(f => f.task)),
    damaged,
    duplicateIds,
    needHealing: tasks.filter(f => f.task.repairs.length > 0),
    projectsNeedHealing: projects.filter(f => f.project.repairs.length > 0),
    membership: membershipOf(projects, tasks),
  };
}

export function tasksInState(snapshot: Snapshot, state: TaskState): TaskFile[] {
  return snapshot.byState.get(state) ?? [];
}

export function countsByState(snapshot: Snapshot): Record<TaskState, number> {
  const counts = {} as Record<TaskState, number>;
  for (const state of TASK_STATES) counts[state] = tasksInState(snapshot, state).length;
  return counts;
}

/** Every id in the snapshot, for resolving an abbreviated reference. */
export function allIds(snapshot: Snapshot): string[] {
  return snapshot.tasks.map(f => f.task.id);
}

/** The membership entry for one project, by its id. */
export function membershipFor(snapshot: Snapshot, projectId: string): ProjectMembership | undefined {
  return snapshot.membership.projects.find(entry => entry.project.project.id === projectId);
}
