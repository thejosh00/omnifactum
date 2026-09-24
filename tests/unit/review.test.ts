import {describe, expect, test} from 'bun:test';
import {
  STALE_WAITING_DAYS,
  appendToLog,
  buildReview,
  daysSinceLastReview,
  summarize,
} from '../../src/core/review.ts';
import {buildSnapshot} from '../../src/core/snapshot.ts';
import type {LogEntry, ProjectFile, TaskFile, TaskState} from '../../src/core/types.ts';

const NOW = '2026-09-12T11:03:00Z';

function task(
  id: string,
  state: TaskState,
  extra: {title?: string; tags?: string[]; due?: string; asked?: string; log?: LogEntry[]} = {},
): TaskFile {
  return {
    task: {
      id,
      title: extra.title ?? id,
      created: '2026-09-01T09:00:00Z',
      state,
      tags: extra.tags ?? ['tagged'],
      body: '',
      log: extra.log ?? [],
      repairs: [],
      ...(extra.due === undefined ? {} : {due: extra.due}),
      ...(extra.asked === undefined ? {} : {asked: extra.asked}),
    },
    stem: id,
    version: 1,
  };
}

function project(stem: string, options: {outcome?: string} = {}): ProjectFile {
  return {
    project: {
      id: `id-${stem}`,
      title: stem,
      outcome: options.outcome ?? 'Done looks like this',
      created: '2026-09-01T09:00:00Z',
      state: 'active',
      tags: [],
      aliases: [],
      body: '',
      log: [],
      repairs: [],
    },
    stem,
    version: 1,
  };
}

const review = (tasks: TaskFile[] = [], projects: ProjectFile[] = []) =>
  buildReview(buildSnapshot(tasks, projects, []), NOW);

const step = (tasks: TaskFile[], projects: ProjectFile[], kind: string) =>
  review(tasks, projects).steps.find(s => s.kind === kind)!;

describe('the walk', () => {
  test('goes through every list, in the order GTD asks them', () => {
    expect(review().steps.map(s => s.kind)).toEqual([
      'inbox',
      'review',
      'next',
      'waiting',
      'projects',
      'someday',
    ]);
  });

  test('every step asks a question and says what it is about', () => {
    for (const s of review().steps) {
      expect(s.title.length).toBeGreaterThan(0);
      expect(s.prompt.length).toBeGreaterThan(0);
    }
  });

  test('an empty system needs no attention at all', () => {
    const plan = review();
    expect(plan.needingAttention).toBe(0);
    expect(plan.steps.every(s => s.flags.length === 0)).toBe(true);
  });
});

describe('what each step notices', () => {
  test('inbox flags anything still unprocessed', () => {
    expect(step([task('a', 'inbox')], [], 'inbox').flags.map(f => f.text)).toEqual([
      '1 item still to be thought about',
    ]);
  });

  test('an empty inbox is clear', () => {
    expect(step([], [], 'inbox').flags.map(f => f.text)).toEqual([]);
  });

  test('review names the work waiting on you, and who did it', () => {
    const log: LogEntry[] = [
      {at: NOW, actor: 'agent:claude-code', text: 'Installed PPD 4.2.', raw: '', parsed: true},
    ];
    const flags = step([task('a', 'review', {title: 'Fix printer', log})], [], 'review').flags.map(f => f.text);
    expect(flags).toEqual(['"Fix printer" is waiting on you (agent:claude-code)']);
  });

  test('next flags an overdue action', () => {
    const flags = step([task('a', 'next', {title: 'File taxes', due: '2026-01-01'})], [], 'next').flags.map(f => f.text);
    expect(flags).toContain('"File taxes" is past its due date');
  });

  test('next flags actions with no tags, which you can never find by context', () => {
    const flags = step([task('a', 'next', {tags: []})], [], 'next').flags.map(f => f.text);
    expect(flags).toContain('1 action has no tags');
  });

  test('a tagged action that is not overdue is not flagged', () => {
    expect(step([task('a', 'next', {tags: ['home']})], [], 'next').flags.map(f => f.text)).toEqual([]);
  });

  test('waiting flags a delegation nobody has chased', () => {
    const asked = '2026-09-01'; // 11 days before NOW
    const flags = step([task('a', 'waiting', {title: 'Invoice', asked})], [], 'waiting').flags.map(f => f.text);
    expect(flags[0]).toContain('"Invoice" has been waiting 11 days');
  });

  test('a recent delegation is left alone', () => {
    const asked = '2026-09-11'; // one day before NOW
    expect(step([task('a', 'waiting', {asked})], [], 'waiting').flags.map(f => f.text)).toEqual([]);
  });

  test('the staleness threshold is the documented one', () => {
    const justUnder = new Date(Date.parse(NOW) - (STALE_WAITING_DAYS - 1) * 86_400_000)
      .toISOString()
      .slice(0, 10);
    const justOver = new Date(Date.parse(NOW) - (STALE_WAITING_DAYS + 1) * 86_400_000)
      .toISOString()
      .slice(0, 10);

    expect(step([task('a', 'waiting', {asked: justUnder})], [], 'waiting').flags.map(f => f.text)).toEqual([]);
    expect(step([task('b', 'waiting', {asked: justOver})], [], 'waiting').flags.map(f => f.text)).toHaveLength(1);
  });

  test('waiting with no asked date is not guessed about', () => {
    expect(step([task('a', 'waiting')], [], 'waiting').flags.map(f => f.text)).toEqual([]);
  });

  test('projects flags a stalled one', () => {
    const flags = step([], [project('kitchen')], 'projects').flags.map(f => f.text);
    expect(flags).toContain('"kitchen" has no next action');
  });

  test('projects flags one with no outcome', () => {
    const flags = step(
      [task('a', 'next', {title: 'Step'})],
      [project('kitchen', {outcome: ''})],
      'projects',
    ).flags.map(f => f.text);
    expect(flags.some(f => f.includes('has no outcome'))).toBe(true);
  });

  test('a project with a next action and an outcome is clear', () => {
    const member = task('a', 'next');
    member.task.project = 'kitchen';
    expect(step([member], [project('kitchen')], 'projects').flags.map(f => f.text)).toEqual([]);
  });

  test('someday is never flagged: it is a prompt to think, not a problem', () => {
    expect(step([task('a', 'someday')], [], 'someday').flags.map(f => f.text)).toEqual([]);
    expect(step([task('a', 'someday')], [], 'someday').count).toBe(1);
  });
});

describe('counting what needs attention', () => {
  test('counts the steps with something in them, not the things', () => {
    const plan = review([task('a', 'inbox'), task('b', 'inbox'), task('c', 'review')]);
    expect(plan.needingAttention).toBe(2);
  });
});

describe('the review log', () => {
  test('a summary records the shape of the system at the time', () => {
    const line = summarize(review([task('a', 'inbox')]));
    expect(line).toContain(NOW);
    expect(line).toContain('inbox 1');
    expect(line).toContain('needed attention');
  });

  test('a clear pass says so', () => {
    expect(summarize(review())).toContain('nothing needed attention');
  });

  test('the first entry creates the document with a heading', () => {
    const written = appendToLog(undefined, '- entry one');
    expect(written).toContain('# Weekly reviews');
    expect(written).toContain('- entry one');
  });

  test('later entries append rather than replacing', () => {
    const first = appendToLog(undefined, '- entry one');
    const second = appendToLog(first, '- entry two');
    expect(second).toContain('- entry one');
    expect(second).toContain('- entry two');
    expect(second.indexOf('entry one')).toBeLessThan(second.indexOf('entry two'));
  });

  test('the log says how long since the last pass', () => {
    const log = appendToLog(undefined, '- 2026-09-05T10:00:00Z — reviewed: inbox 0.');
    expect(daysSinceLastReview(log, NOW)).toBe(7);
  });

  test('the most recent entry is the one that counts', () => {
    let log = appendToLog(undefined, '- 2026-08-01T10:00:00Z — reviewed: inbox 0.');
    log = appendToLog(log, '- 2026-09-11T10:00:00Z — reviewed: inbox 0.');
    expect(daysSinceLastReview(log, NOW)).toBe(1);
  });

  test('no log at all means no answer, rather than a wrong one', () => {
    expect(daysSinceLastReview(undefined, NOW)).toBeUndefined();
    expect(daysSinceLastReview('# Weekly reviews\n', NOW)).toBeUndefined();
  });
});
