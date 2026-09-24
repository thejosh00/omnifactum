import {describe, expect, test} from 'bun:test';
import {
  daysUntil,
  formatDefer,
  formatDue,
  metaSegments,
  metaWidth,
  shortDate,
  timeAgo,
} from '../../src/core/format.ts';

const NOW = '2026-09-12T11:03:00Z';

describe('counting days', () => {
  test('counts by calendar day, not by elapsed hours', () => {
    // Late tonight and early tomorrow, on the local (Chicago) calendar, are one day apart.
    expect(daysUntil('2026-09-13T00:30:00-05:00', '2026-09-12T23:30:00-05:00')).toBe(1);
  });

  test('today is zero whatever the time', () => {
    expect(daysUntil('2026-09-12T23:59:00-05:00', '2026-09-12T00:01:00-05:00')).toBe(0);
  });

  test('the past is negative', () => {
    expect(daysUntil('2026-09-10', NOW)).toBe(-2);
  });

  test('a bare date is read as that whole day', () => {
    expect(daysUntil('2026-09-14', NOW)).toBe(2);
  });

  test('nonsense gives no answer rather than a wrong one', () => {
    expect(daysUntil('not a date', NOW)).toBeUndefined();
  });
});

describe('how a deadline reads', () => {
  test('overdue says how far, and is marked urgent', () => {
    expect(formatDue('2026-09-10', NOW)).toEqual({text: 'overdue 2d', urgency: 'overdue'});
  });

  test('today and tomorrow are named rather than counted', () => {
    expect(formatDue('2026-09-12', NOW).text).toBe('due today');
    expect(formatDue('2026-09-13', NOW).text).toBe('due tomorrow');
  });

  test('the next week is relative, because that is the question you are asking', () => {
    expect(formatDue('2026-09-15', NOW)).toEqual({text: 'due in 3d', urgency: 'soon'});
  });

  test('further out is a date, because "in 40 days" tells you nothing', () => {
    expect(formatDue('2026-10-15', NOW).text).toBe('due 15 Oct');
  });

  test('far away keeps the full date, since the year matters by then', () => {
    expect(formatDue('2027-06-01', NOW).text).toBe('due 2027-06-01');
  });

  test('an unreadable date is shown as written rather than dropped', () => {
    expect(formatDue('sometime', NOW).text).toBe('due sometime');
  });

  test('urgency is graded, so colour has something to follow', () => {
    expect(formatDue('2026-09-10', NOW).urgency).toBe('overdue');
    expect(formatDue('2026-09-12', NOW).urgency).toBe('today');
    expect(formatDue('2026-09-15', NOW).urgency).toBe('soon');
    expect(formatDue('2026-10-15', NOW).urgency).toBe('later');
  });
});

describe('how a deferred task reads', () => {
  test('a date that has arrived says so', () => {
    expect(formatDefer('2026-09-01', NOW)).toBe('ready now');
  });

  test('the near future counts down', () => {
    expect(formatDefer('2026-09-13', NOW)).toBe('hidden until tomorrow');
    expect(formatDefer('2026-09-20', NOW)).toBe('hidden 8d more');
  });

  test('the far future gives a date', () => {
    expect(formatDefer('2026-11-01', NOW)).toBe('hidden until 1 Nov');
  });
});

describe('small helpers', () => {
  test('shortDate is readable and short', () => {
    expect(shortDate('2026-10-15')).toBe('15 Oct');
    expect(shortDate('2026-01-01')).toBe('1 Jan');
  });

  test('timeAgo reads naturally in both directions', () => {
    expect(timeAgo('2026-09-12', NOW)).toBe('today');
    expect(timeAgo('2026-09-11', NOW)).toBe('yesterday');
    expect(timeAgo('2026-09-05', NOW)).toBe('7d ago');
    expect(timeAgo('2026-09-15', NOW)).toBe('in 3d');
  });
});

describe('the annotations that follow a title', () => {
  const task = {
    tags: ['home', 'agent'],
    project: 'kitchen',
    due: '2026-09-15',
    waitingOn: undefined,
    defer: undefined,
  };

  test('come out in a stable order: project, tags, then dates', () => {
    expect(metaSegments(task, NOW).map(s => s.text)).toEqual([
      '+kitchen',
      '#home',
      '#agent',
      'due in 3d',
    ]);
  });

  test('a dangling project reference is marked, not just coloured', () => {
    const segments = metaSegments(task, NOW, {dangling: true});
    expect(segments[0]?.text).toBe('+kitchen?');
    expect(segments[0]?.dangling).toBe(true);
  });

  test('a task with nothing to say has no annotations at all', () => {
    expect(metaSegments({tags: []}, NOW)).toEqual([]);
  });

  test('a deferred task says so only while it is still hidden', () => {
    const deferred = {tags: [], defer: '2026-11-01'};
    expect(metaSegments(deferred, NOW, {deferred: true}).map(s => s.kind)).toEqual(['defer']);
    expect(metaSegments(deferred, NOW, {deferred: false})).toEqual([]);
  });

  test('a delegation names who owes you', () => {
    const segments = metaSegments({tags: [], waitingOn: 'Acme'}, NOW);
    expect(segments[0]).toMatchObject({kind: 'waiting', text: 'waiting on Acme'});
  });

  test('a submission names who handed it in and how long it has waited', () => {
    const segments = metaSegments(
      {tags: [], submitted: {actor: 'agent:claude', at: '2026-09-10T08:00:00Z'}},
      NOW,
    );
    expect(segments[0]).toMatchObject({kind: 'submitted', text: 'agent:claude 2d ago', actor: 'agent:claude'});
  });

  test('a submission with no named actor is just its age', () => {
    const segments = metaSegments({tags: [], submitted: {actor: '', at: NOW}}, NOW);
    expect(segments[0]?.text).toBe('today');
    expect(segments[0]?.actor).toBeUndefined();
  });
});

describe('measuring the annotations', () => {
  // The layout depends on this being right: the widest row decides the title column,
  // and an undercount makes rows overflow, which Ink resolves by eating spaces.
  test('counts the pieces and the single space between them', () => {
    const segments = metaSegments({tags: ['home', 'agent']}, NOW);
    expect(metaWidth(segments)).toBe('#home #agent'.length);
  });

  test('nothing measures as nothing, not as one space', () => {
    expect(metaWidth([])).toBe(0);
  });

  test('one piece has no separator', () => {
    expect(metaWidth(metaSegments({tags: ['home']}, NOW))).toBe('#home'.length);
  });

  test('the measurement matches what would be rendered', () => {
    const segments = metaSegments(
      {tags: ['home'], project: 'kitchen', due: '2026-09-15', waitingOn: 'Acme'},
      NOW,
    );
    const rendered = segments.map(s => s.text).join(' ');
    expect(metaWidth(segments)).toBe(rendered.length);
  });
});
