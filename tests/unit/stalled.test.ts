import {describe, expect, test} from 'bun:test';
import {membershipOf, projectsWithoutOutcome, stalledProjects} from '../../src/core/stalled.ts';
import type {ProjectFile, ProjectState, TaskFile, TaskState} from '../../src/core/types.ts';

function project(stem: string, overrides: {state?: ProjectState; id?: string; outcome?: string; aliases?: string[]} = {}): ProjectFile {
  return {
    project: {
      id: overrides.id ?? `id-${stem}`,
      title: stem,
      outcome: overrides.outcome ?? 'Done looks like this',
      created: '2026-09-01T09:00:00Z',
      state: overrides.state ?? 'active',
      tags: [],
      aliases: overrides.aliases ?? [],
      body: '',
      log: [],
      repairs: [],
    },
    stem,
    version: 1,
  };
}

function task(stem: string, state: TaskState, projectRef?: string): TaskFile {
  return {
    task: {
      id: `id-${stem}`,
      title: stem,
      created: '2026-09-01T09:00:00Z',
      state,
      tags: [],
      body: '',
      log: [],
      repairs: [],
      ...(projectRef === undefined ? {} : {project: projectRef}),
    },
    stem,
    version: 1,
  };
}

describe('what counts as stalled', () => {
  test('an active project with a next action is not stalled', () => {
    const report = membershipOf([project('kitchen')], [task('order-tiles', 'next', 'kitchen')]);
    expect(report.projects[0]?.stalled).toBe(false);
  });

  test('an active project with nothing live is stalled', () => {
    const report = membershipOf([project('kitchen')], []);
    expect(report.projects[0]?.stalled).toBe(true);
  });

  test('a waiting task counts as live: someone else simply owes you something', () => {
    const report = membershipOf([project('kitchen')], [task('quote', 'waiting', 'kitchen')]);
    expect(report.projects[0]?.stalled).toBe(false);
  });

  test('inbox, someday and done do not count as live', () => {
    for (const state of ['inbox', 'someday', 'done'] as const) {
      const report = membershipOf([project('kitchen')], [task('x', state, 'kitchen')]);
      expect(report.projects[0]?.stalled).toBe(true);
    }
  });

  test('a someday project is never stalled, because it is not meant to be moving', () => {
    const report = membershipOf([project('kitchen', {state: 'someday'})], []);
    expect(report.projects[0]?.stalled).toBe(false);
  });

  test('a done project is never stalled', () => {
    const report = membershipOf([project('kitchen', {state: 'done'})], []);
    expect(report.projects[0]?.stalled).toBe(false);
  });

  test('stalledProjects returns only the stalled ones', () => {
    const report = membershipOf(
      [project('moving'), project('stuck')],
      [task('go', 'next', 'moving')],
    );
    expect(stalledProjects(report).map(e => e.project.stem)).toEqual(['stuck']);
  });
});

describe('counting members', () => {
  test('splits live from done', () => {
    const report = membershipOf(
      [project('kitchen')],
      [
        task('a', 'next', 'kitchen'),
        task('b', 'waiting', 'kitchen'),
        task('c', 'done', 'kitchen'),
        task('d', 'someday', 'kitchen'),
      ],
    );
    const entry = report.projects[0]!;
    expect(entry.tasks).toHaveLength(4);
    expect(entry.live).toHaveLength(2);
    expect(entry.done).toHaveLength(1);
  });

  test('a task with no project belongs to none of them', () => {
    const report = membershipOf([project('kitchen')], [task('loose', 'next')]);
    expect(report.projects[0]?.tasks).toEqual([]);
    expect(report.orphans).toEqual([]);
  });

  test('membership resolves through an alias, not just the current stem', () => {
    const report = membershipOf(
      [project('kitchen-refit', {aliases: ['renovate-kitchen']})],
      [task('tiles', 'next', 'renovate-kitchen')],
    );
    expect(report.projects[0]?.live).toHaveLength(1);
    expect(report.orphans).toEqual([]);
  });
});

describe('dangling links', () => {
  test('a task pointing at a project that does not exist is reported', () => {
    const report = membershipOf([project('kitchen')], [task('tiles', 'next', 'bathroom')]);
    expect(report.orphans).toHaveLength(1);
    expect(report.orphans[0]?.ref).toBe('bathroom');
  });

  test('a dangling link does not silently attach to some other project', () => {
    const report = membershipOf([project('kitchen')], [task('tiles', 'next', 'bathroom')]);
    expect(report.projects[0]?.tasks).toEqual([]);
  });

  test('with no projects at all, every link dangles rather than throwing', () => {
    const report = membershipOf([], [task('tiles', 'next', 'kitchen')]);
    expect(report.orphans).toHaveLength(1);
    expect(report.projects).toEqual([]);
  });
});

describe('projects missing an outcome', () => {
  test('are listed for a person to answer', () => {
    const found = projectsWithoutOutcome([
      project('good'),
      project('vague', {outcome: ''}),
      project('blank', {outcome: '   '}),
    ]);
    expect(found.map(p => p.stem)).toEqual(['vague', 'blank']);
  });
});
