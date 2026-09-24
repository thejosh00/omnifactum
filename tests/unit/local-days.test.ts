/**
 * Calendar days are local, not UTC.
 *
 * The suite runs in America/Chicago (see tests/setup.ts). Every moment below is 9pm there
 * on 23 September, which is already 24 September in UTC — exactly the evening where
 * counting in UTC used to put things a day out.
 */
import {describe, expect, test} from 'bun:test';
import {resolveDate} from '../../src/core/filter.ts';
import {formatDue, timeAgo} from '../../src/core/format.ts';
import {planReviewed} from '../../src/core/project.ts';
import {deferReached, isOverdue} from '../../src/core/tickler.ts';
import {addLocalDays, daysBetweenLocal, localDate} from '../../src/core/time.ts';
import type {Project, Task} from '../../src/core/types.ts';

const EVENING = '2026-09-24T02:00:00Z'; // 9pm on the 23rd in Chicago

function task(fields: Partial<Task>): Task {
  return {id: 'x', title: 't', created: '2026-09-01T00:00:00Z', state: 'next', tags: [], body: '', log: [], repairs: [], ...fields};
}

describe('an evening in Chicago', () => {
  test('it is still the 23rd', () => {
    expect(localDate(EVENING)).toBe('2026-09-23');
    expect(resolveDate('today', EVENING)).toBe('2026-09-23');
    expect(resolveDate('tomorrow', EVENING)).toBe('2026-09-24');
  });

  test('something due today is due today, not overdue', () => {
    expect(isOverdue(task({due: '2026-09-23'}), EVENING)).toBe(false);
    expect(formatDue('2026-09-23', EVENING).urgency).toBe('today');
    expect(formatDue('2026-09-24', EVENING).text).toBe('due tomorrow');
  });

  test('it goes overdue at local midnight', () => {
    expect(isOverdue(task({due: '2026-09-23'}), '2026-09-24T04:59:00Z')).toBe(false); // 11:59pm
    expect(isOverdue(task({due: '2026-09-23'}), '2026-09-24T05:01:00Z')).toBe(true); // 12:01am
  });

  test('a task deferred until tomorrow stays hidden tonight', () => {
    expect(deferReached('2026-09-24', EVENING)).toBe(false);
    expect(deferReached('2026-09-24', '2026-09-24T05:00:00Z')).toBe(true); // midnight
  });

  test('a review this evening is stamped today, and reads as today', () => {
    const project = {id: 'p', title: 'P', outcome: 'o', created: EVENING, state: 'active', tags: [], aliases: [], body: '', log: [], repairs: []} as Project;
    const reviewed = planReviewed(project, EVENING).reviewed!;
    expect(reviewed).toBe('2026-09-23');
    expect(timeAgo(reviewed, EVENING)).toBe('today');
  });
});

describe('across a clock change', () => {
  test('the day the clocks go back is still one day', () => {
    // 1 November 2026: 25 hours long in Chicago.
    expect(daysBetweenLocal('2026-10-31', '2026-11-02')).toBe(2);
    expect(addLocalDays('2026-10-31', 2)).toBe('2026-11-02');
    expect(addLocalDays('2026-03-07', 1)).toBe('2026-03-08');
  });
});
