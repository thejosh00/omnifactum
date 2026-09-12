/**
 * Which projects are moving, and which have quietly stopped.
 *
 * A stalled project is an active project with nothing you could actually do about it.
 * Catching those is most of what a weekly review is for, and it is the main thing
 * first-class projects buy over a `#proj-whatever` tag: a tag cannot notice its own
 * absence.
 */
import {resolveProjectRef} from './project.ts';
import type {ProjectFile, TaskFile} from './types.ts';

/**
 * States in which a task can still move its project forward.
 *
 * `review` counts: the work is done and waiting on you to check it, which is progress,
 * not a stall. Leaving it out would have the weekly review nag about projects that are
 * actually moving.
 */
const LIVE_STATES = new Set(['next', 'waiting', 'review']);

export interface ProjectMembership {
  project: ProjectFile;
  /** Every task pointing at this project, in any state. */
  tasks: TaskFile[];
  /**
   * Tasks that could move it forward now. `waiting` counts: the project is not
   * stalled, someone else simply owes you something.
   */
  live: TaskFile[];
  done: TaskFile[];
  /** Active, but with nothing live. This is what a weekly review hunts for. */
  stalled: boolean;
}

export interface MembershipReport {
  projects: ProjectMembership[];
  /** Tasks whose `project:` field does not resolve to anything. */
  orphans: Array<{file: TaskFile; ref: string}>;
}

export function membershipOf(
  projects: readonly ProjectFile[],
  tasks: readonly TaskFile[],
): MembershipReport {
  const byProjectId = new Map<string, TaskFile[]>();
  for (const project of projects) byProjectId.set(project.project.id, []);

  const orphans: Array<{file: TaskFile; ref: string}> = [];

  for (const file of tasks) {
    const ref = file.task.project;
    if (ref === undefined) continue;

    const match = resolveProjectRef(projects, ref);
    if (match.kind !== 'ok') {
      // An unresolved reference is not an error. It is reported, and `doctor` offers
      // to repoint it, because the readable-slug format makes this recoverable.
      orphans.push({file, ref});
      continue;
    }
    byProjectId.get(match.project.project.id)!.push(file);
  }

  const report = projects.map(project => {
    const members = byProjectId.get(project.project.id) ?? [];
    const live = members.filter(f => LIVE_STATES.has(f.task.state));
    return {
      project,
      tasks: members,
      live,
      done: members.filter(f => f.task.state === 'done'),
      stalled: project.project.state === 'active' && live.length === 0,
    };
  });

  return {projects: report, orphans};
}

export function stalledProjects(report: MembershipReport): ProjectMembership[] {
  return report.projects.filter(entry => entry.stalled);
}

/** Projects with no outcome statement, which is the other thing GTD asks you to fix. */
export function projectsWithoutOutcome(projects: readonly ProjectFile[]): ProjectFile[] {
  return projects.filter(p => p.project.outcome.trim().length === 0);
}
