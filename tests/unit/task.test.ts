import {describe, expect, test} from 'bun:test';
import {readTask, titleFromStem, writeTask} from '../../src/core/task.ts';
import {appendLogEntry} from '../../src/core/log.ts';
import type {TaskReadContext} from '../../src/core/task.ts';
import type {Task} from '../../src/core/types.ts';

const MINTED = 'zzzzzzzzzzzz';

function context(overrides: Partial<TaskReadContext> = {}): TaskReadContext {
  return {
    state: 'next',
    stem: 'fix-printer-driver',
    birthtimeMs: Date.UTC(2026, 8, 1, 9, 0, 0),
    mtimeMs: Date.UTC(2026, 8, 12, 11, 3, 0),
    nowIso: '2026-09-12T12:00:00Z',
    mintId: () => MINTED,
    ...overrides,
  };
}

/** The file from the approved format, verbatim. */
const CANONICAL = `---
id: 0tq7f2k9abcd
title: Fix printer driver
tags: [home, errand, agent]
created: 2026-09-12T10:04:00Z
---

Driver crashes after the OS update. Try the vendor PPD first.

## Log

- 2026-09-12T11:03:00Z **agent:claude-code** — Installed vendor PPD 4.2, test page prints clean.
`;

function ok(raw: string, ctx = context()): Task {
  const result = readTask(raw, ctx);
  if (result.kind !== 'ok') throw new Error(`expected a readable task, got: ${result.reason}`);
  return result.task;
}

describe('reading the canonical task file', () => {
  const task = ok(CANONICAL);

  test('reads every field', () => {
    expect(task.id).toBe('0tq7f2k9abcd');
    expect(task.title).toBe('Fix printer driver');
    expect(task.created).toBe('2026-09-12T10:04:00Z');
    expect(task.tags).toEqual(['home', 'errand', 'agent']);
  });

  test('takes its state from the directory, not from any field', () => {
    expect(task.state).toBe('next');
    expect(ok(CANONICAL, context({state: 'someday'})).state).toBe('someday');
  });

  test('separates the prose from the log', () => {
    expect(task.body.trim()).toBe('Driver crashes after the OS update. Try the vendor PPD first.');
    expect(task.log).toHaveLength(1);
    expect(task.log[0]?.actor).toBe('agent:claude-code');
  });

  test('needs no healing', () => {
    const result = readTask(CANONICAL, context());
    expect(result.kind === 'ok' && result.needsHealing).toBe(false);
    expect(task.repairs).toEqual([]);
  });
});

describe('a file missing anything is still a task', () => {
  test('a bare markdown note an agent dropped in is readable', () => {
    const task = ok('Pick up the dry cleaning.\n', context({stem: 'dry-cleaning'}));
    expect(task.id).toBe(MINTED);
    expect(task.title).toBe('Dry cleaning');
    expect(task.body).toContain('Pick up the dry cleaning.');
    expect(task.repairs.map(r => r.kind)).toContain('missing-id');
  });

  test('a heading in the body is preferred over the filename for a title', () => {
    const task = ok('# Call the bank about the overdraft\n\nbody\n', context({stem: 'note'}));
    expect(task.title).toBe('Call the bank about the overdraft');
  });

  test('a `## Log` heading is never mistaken for a title', () => {
    const task = ok('## Log\n\n- 2026-09-12T11:03:00Z **you** — did it\n', context({stem: 'thing'}));
    expect(task.title).toBe('Thing');
  });

  test('a missing created date falls back to the file birth time', () => {
    const task = ok('---\nid: 0tq7f2k9abcd\ntitle: x\n---\n', context());
    expect(task.created).toBe('2026-09-01T09:00:00.000Z');
    expect(task.repairs.map(r => r.kind)).toContain('missing-created');
  });

  test('an invalid id is replaced rather than trusted', () => {
    const task = ok('---\nid: not-an-id\ntitle: x\ncreated: 2026-09-12T10:04:00Z\n---\n');
    expect(task.id).toBe(MINTED);
    expect(task.repairs.map(r => r.kind)).toContain('missing-id');
  });

  test('an id in the wrong case is accepted, not replaced', () => {
    const task = ok('---\nid: 0TQ7F2K9ABCD\ntitle: x\ncreated: 2026-09-12T10:04:00Z\n---\n');
    expect(task.id).toBe('0tq7f2k9abcd');
    expect(task.repairs).toEqual([]);
  });
});

describe('damaged frontmatter is reported, never guessed at', () => {
  test('an unquoted colon makes genuinely invalid YAML, and that is detected', () => {
    const result = readTask('---\ntitle: Call Bob re: budget\nid: x\n---\n', context());
    expect(result.kind).toBe('damaged');
  });
});

describe('the rules the directory layout depends on', () => {
  test('defer outside someday is flagged, because next/ must be taken at face value', () => {
    const raw = '---\nid: 0tq7f2k9abcd\ntitle: x\ncreated: 2026-09-12T10:04:00Z\ndefer: 2026-11-01\n---\n';
    expect(ok(raw, context({state: 'next'})).repairs.map(r => r.kind)).toContain(
      'defer-outside-someday',
    );
    expect(ok(raw, context({state: 'someday'})).repairs).toEqual([]);
  });

  test('a completed task with no done date gets one from the file', () => {
    const task = ok(
      '---\nid: 0tq7f2k9abcd\ntitle: x\ncreated: 2026-09-12T10:04:00Z\n---\n',
      context({state: 'done', month: '2026-09'}),
    );
    expect(task.done).toBe('2026-09-12T11:03:00.000Z');
    expect(task.repairs.map(r => r.kind)).toContain('missing-done');
  });

  test('a done date disagreeing with its month folder is flagged', () => {
    const raw =
      '---\nid: 0tq7f2k9abcd\ntitle: x\ncreated: 2026-09-12T10:04:00Z\ndone: 2026-10-01T00:00:00Z\n---\n';
    expect(ok(raw, context({state: 'done', month: '2026-09'})).repairs.map(r => r.kind)).toContain(
      'done-month-mismatch',
    );
  });

  test('a tag YAML would coerce to a number is reported', () => {
    const raw = '---\nid: 0tq7f2k9abcd\ntitle: x\ncreated: 2026-09-12T10:04:00Z\ntags: [2026, home]\n---\n';
    const task = ok(raw);
    expect(task.tags).toEqual(['2026', 'home']);
    expect(task.repairs.map(r => r.kind)).toContain('coerced-tag');
  });
});

describe('writing', () => {
  test('an unmodified task round-trips byte for byte', () => {
    expect(writeTask(ok(CANONICAL), CANONICAL)).toBe(CANONICAL);
  });

  test('changing one field leaves every other byte alone', () => {
    const original = `---
# a comment the user wrote
id: 0tq7f2k9abcd
title: Fix printer driver
energy: low
created: 2026-09-12T10:04:00Z
---

Body prose.
`;
    const task = ok(original);
    const out = writeTask({...task, title: 'Fix the printer driver'}, original);

    expect(out).toContain('title: Fix the printer driver');
    expect(out).toContain('# a comment the user wrote');
    expect(out).toContain('energy: low'); // a field the app knows nothing about
    expect(out).toContain('Body prose.');
  });

  test('a new task writes a short, readable file', () => {
    const task: Task = {
      id: '0tq7f2k9abcd',
      title: 'Fix printer driver',
      created: '2026-09-12T10:04:00Z',
      state: 'inbox',
      tags: ['home', 'agent'],
      body: '',
      log: [],
      repairs: [],
    };
    expect(writeTask(task, '')).toBe(
      '---\nid: 0tq7f2k9abcd\ntitle: Fix printer driver\ncreated: 2026-09-12T10:04:00Z\ntags: [home, agent]\n---\n',
    );
  });

  test('an appended log entry lands at the very end of the file', () => {
    const task = ok(CANONICAL);
    const out = writeTask(
      {...task, log: appendLogEntry(task.log, '2026-09-12T12:00:00Z', 'you', 'Checked it.')},
      CANONICAL,
    );
    expect(out.trimEnd().endsWith('Checked it.')).toBe(true);
    expect(out).toContain('Installed vendor PPD 4.2');
  });

  test('a field set to undefined disappears from the file', () => {
    const raw = '---\nid: 0tq7f2k9abcd\ntitle: x\ncreated: 2026-09-12T10:04:00Z\ndue: 2026-10-15\n---\n';
    const task = ok(raw);
    const out = writeTask({...task, due: undefined}, raw);
    expect(out).not.toContain('due');
  });

  test('refuses to write over frontmatter that did not parse', () => {
    const task = ok(CANONICAL);
    expect(() => writeTask(task, '---\ntitle: Bob re: x\n---\n')).toThrow(/did not parse/);
  });

  test('healing a bare file produces a valid task file', () => {
    const bare = 'Pick up the dry cleaning.\n';
    const task = ok(bare, context({stem: 'dry-cleaning'}));
    const out = writeTask(task, bare);

    const reread = readTask(out, context({stem: 'dry-cleaning'}));
    expect(reread.kind).toBe('ok');
    if (reread.kind === 'ok') {
      expect(reread.needsHealing).toBe(false);
      expect(reread.task.id).toBe(MINTED);
      expect(reread.task.body).toContain('Pick up the dry cleaning.');
    }
  });

  test('writing twice is stable', () => {
    const once = writeTask(ok(CANONICAL), CANONICAL);
    expect(writeTask(ok(once), once)).toBe(once);
  });
});

describe('titleFromStem', () => {
  test('reads as a sentence', () => {
    expect(titleFromStem('fix-printer-driver')).toBe('Fix printer driver');
  });

  test('leaves an id-shaped stem alone apart from casing', () => {
    expect(titleFromStem('0tq7f2k9abcd')).toBe('0tq7f2k9abcd');
  });
});
