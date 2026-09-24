import {describe, expect, test} from 'bun:test';
import {
  planNewProject,
  planRenameProject,
  planSetOutcome,
  readProject,
  resolveProjectRef,
  writeProject,
} from '../../src/core/project.ts';
import type {ProjectReadContext} from '../../src/core/project.ts';
import type {Project, ProjectFile} from '../../src/core/types.ts';

const MINTED = 'zzzzzzzzzzzz';

function context(overrides: Partial<ProjectReadContext> = {}): ProjectReadContext {
  return {
    state: 'active',
    stem: 'renovate-kitchen',
    birthtimeMs: Date.UTC(2026, 8, 1, 9, 0, 0),
    mtimeMs: Date.UTC(2026, 8, 12, 11, 3, 0),
    mintId: () => MINTED,
    ...overrides,
  };
}

const CANONICAL = `---
id: 0tq7g0a2cdef
title: Renovate the kitchen
outcome: New kitchen finished, signed off and paid for
created: 2026-09-01T09:00:00Z
tags: [home]
---

Waiting on the quote from the second contractor.
`;

function ok(raw: string, ctx = context()): Project {
  const result = readProject(raw, ctx);
  if (result.kind !== 'ok') throw new Error(`expected a project, got: ${result.reason}`);
  return result.project;
}

describe('reading a project', () => {
  const project = ok(CANONICAL);

  test('reads every field', () => {
    expect(project.id).toBe('0tq7g0a2cdef');
    expect(project.title).toBe('Renovate the kitchen');
    expect(project.outcome).toBe('New kitchen finished, signed off and paid for');
    expect(project.tags).toEqual(['home']);
  });

  test('takes its state from the directory, exactly like a task', () => {
    expect(project.state).toBe('active');
    expect(ok(CANONICAL, context({state: 'someday'})).state).toBe('someday');
  });

  test('needs no healing', () => {
    expect(project.repairs).toEqual([]);
  });
});

describe('a project without an outcome', () => {
  const raw = '---\nid: 0tq7g0a2cdef\ntitle: Vague ambition\ncreated: 2026-09-01T09:00:00Z\n---\n';

  test('is still readable', () => {
    expect(ok(raw).title).toBe('Vague ambition');
  });

  test('is reported, because that is the thing GTD exists to catch', () => {
    expect(ok(raw).repairs.map(r => r.kind)).toContain('missing-outcome');
  });

  test('is never given an invented outcome', () => {
    expect(ok(raw).outcome).toBe('');
  });

  test('cannot be created that way in the first place', () => {
    expect(() =>
      planNewProject({id: MINTED, title: 'Vague', outcome: '  ', nowIso: '2026-09-12T11:03:00Z'}),
    ).toThrow(/what does done look like/);
  });

  test('cannot have its outcome cleared later either', () => {
    expect(() => planSetOutcome(ok(CANONICAL), '')).toThrow(/what does done look like/);
  });
});

describe('writing a project', () => {
  test('an unmodified project round-trips byte for byte', () => {
    expect(writeProject(ok(CANONICAL), CANONICAL)).toBe(CANONICAL);
  });

  test('a new project writes a readable file', () => {
    const project = planNewProject({
      id: '0tq7g0a2cdef',
      title: 'Renovate the kitchen',
      outcome: 'New kitchen finished and paid for',
      nowIso: '2026-09-01T09:00:00Z',
      tags: ['home'],
    });
    expect(writeProject(project, '')).toBe(
      '---\nid: 0tq7g0a2cdef\ntitle: Renovate the kitchen\noutcome: New kitchen finished and paid for\ncreated: 2026-09-01T09:00:00Z\ntags: [home]\n---\n',
    );
  });

  test('a comment and an unknown field survive an edit', () => {
    const original =
      '---\n# my note\nid: 0tq7g0a2cdef\ntitle: Old\noutcome: Something\ncreated: 2026-09-01T09:00:00Z\nbudget: 12000\n---\n';
    const out = writeProject({...ok(original), title: 'New'}, original);
    expect(out).toContain('# my note');
    expect(out).toContain('budget: 12000');
    expect(out).toContain('title: New');
  });

  test('writing twice is stable', () => {
    const once = writeProject(ok(CANONICAL), CANONICAL);
    expect(writeProject(ok(once), once)).toBe(once);
  });
});

describe('renaming records an alias', () => {
  test('so a task that still uses the old stem keeps resolving', () => {
    const renamed = planRenameProject(ok(CANONICAL), 'renovate-kitchen', 'Kitchen refit');
    expect(renamed.title).toBe('Kitchen refit');
    expect(renamed.aliases).toEqual(['renovate-kitchen']);
  });

  test('renaming twice keeps both old names', () => {
    const once = planRenameProject(ok(CANONICAL), 'renovate-kitchen', 'Kitchen refit');
    const twice = planRenameProject(once, 'kitchen-refit', 'Kitchen');
    expect(twice.aliases).toEqual(['renovate-kitchen', 'kitchen-refit']);
  });

  test('the same rename is not recorded twice', () => {
    const once = planRenameProject(ok(CANONICAL), 'renovate-kitchen', 'A');
    expect(planRenameProject(once, 'renovate-kitchen', 'B').aliases).toEqual(['renovate-kitchen']);
  });

  test('an alias survives being written and read back', () => {
    const renamed = planRenameProject(ok(CANONICAL), 'renovate-kitchen', 'Kitchen refit');
    const raw = writeProject(renamed, CANONICAL);
    expect(ok(raw, context({stem: 'kitchen-refit'})).aliases).toEqual(['renovate-kitchen']);
  });
});

describe('the project reference cascade', () => {
  function file(overrides: Partial<Project> & {stem: string}): ProjectFile {
    const {stem, ...rest} = overrides;
    return {
      project: {
        id: '0tq7g0a2cdef',
        title: 'Renovate the kitchen',
        outcome: 'Done',
        created: '2026-09-01T09:00:00Z',
        state: 'active',
        tags: [],
        aliases: [],
        body: '',
        log: [],
        repairs: [],
        ...rest,
      },
      stem,
      version: 1,
    };
  }

  const kitchen = file({stem: 'renovate-kitchen'});
  const projects = [kitchen];

  test('1. the filename stem, which is the normal case', () => {
    const match = resolveProjectRef(projects, 'renovate-kitchen');
    expect(match).toMatchObject({kind: 'ok', via: 'stem'});
  });

  test('2. the id, for anyone who prefers to be explicit', () => {
    expect(resolveProjectRef(projects, '0tq7g0a2cdef')).toMatchObject({kind: 'ok', via: 'id'});
  });

  test('3. the slug of the title, which survives a file being renamed to match it', () => {
    const renamedByHand = [file({stem: 'kitchen-2024-FINAL'})];
    expect(resolveProjectRef(renamedByHand, 'renovate-the-kitchen')).toMatchObject({
      kind: 'ok',
      via: 'title',
    });
  });

  test('4. an alias, which is how the app\'s own renames stay linked', () => {
    const withAlias = [file({stem: 'kitchen-refit', aliases: ['renovate-kitchen']})];
    expect(resolveProjectRef(withAlias, 'renovate-kitchen')).toMatchObject({
      kind: 'ok',
      via: 'alias',
    });
  });

  test('5. an unambiguous id prefix', () => {
    expect(resolveProjectRef(projects, '0tq7g0a2')).toMatchObject({kind: 'ok', via: 'prefix'});
  });

  test('matching folds case, because APFS does', () => {
    expect(resolveProjectRef(projects, 'Renovate-Kitchen')).toMatchObject({kind: 'ok'});
  });

  test('a reference to nothing resolves to nothing, not to the first project', () => {
    expect(resolveProjectRef(projects, 'nonexistent')).toEqual({kind: 'none'});
    expect(resolveProjectRef(projects, '')).toEqual({kind: 'none'});
  });

  test('an ambiguous reference reports its candidates instead of guessing', () => {
    const two = [file({stem: 'kitchen'}), file({stem: 'other', aliases: ['kitchen']})];
    // The stem wins outright here, so ambiguity needs two files sharing a step.
    const both = [file({stem: 'a', aliases: ['shared']}), file({stem: 'b', aliases: ['shared']})];
    expect(resolveProjectRef(two, 'kitchen')).toMatchObject({kind: 'ok', via: 'stem'});
    expect(resolveProjectRef(both, 'shared')).toMatchObject({kind: 'ambiguous'});
  });

  test('an earlier step in the cascade beats a later one', () => {
    const conflicting = [
      file({stem: 'target'}),
      file({stem: 'decoy', id: '0tq7g0a2zzzz', aliases: ['target']}),
    ];
    expect(resolveProjectRef(conflicting, 'target')).toMatchObject({via: 'stem'});
  });
});
