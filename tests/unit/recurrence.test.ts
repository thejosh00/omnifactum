import {describe, expect, test} from 'bun:test';
import {
  asSchedule,
  describeSchedule,
  firstOn,
  nextAfter,
  parseSchedule,
  scheduleText,
  type Schedule,
} from '../../src/core/recurrence.ts';

// A Wednesday, in Chicago (tests/setup.ts).
const NOW = '2026-09-23T15:00:00Z';
const WED = '2026-09-23';

describe('when a tickler item fires', () => {
  test('weekly: today if it is the day, otherwise the next one', () => {
    expect(firstOn({kind: 'weekly', weekday: 3}, WED)).toBe(WED);
    expect(firstOn({kind: 'weekly', weekday: 1}, WED)).toBe('2026-09-28');
    expect(nextAfter({kind: 'weekly', weekday: 3}, WED)).toBe('2026-09-30');
  });

  test('monthly: this month if not passed, otherwise next month', () => {
    expect(firstOn({kind: 'monthly', day: 23}, WED)).toBe(WED);
    expect(firstOn({kind: 'monthly', day: 15}, WED)).toBe('2026-10-15');
    expect(nextAfter({kind: 'monthly', day: 23}, WED)).toBe('2026-10-23');
  });

  test('monthly on the 31st uses the last day of a shorter month', () => {
    const s: Schedule = {kind: 'monthly', day: 31};
    expect(nextAfter(s, '2027-01-31')).toBe('2027-02-28');
    expect(nextAfter(s, '2028-01-31')).toBe('2028-02-29');
    expect(nextAfter(s, '2027-02-28')).toBe('2027-03-31');
  });

  test('once fires on its date, past or future, and never again', () => {
    expect(firstOn({kind: 'once', date: '2026-01-01'}, WED)).toBe('2026-01-01');
    expect(firstOn({kind: 'once', date: '2027-03-01'}, WED)).toBe('2027-03-01');
    expect(nextAfter({kind: 'once', date: WED}, WED)).toBeUndefined();
  });

  test('crosses the daylight-saving change as whole days', () => {
    // US clocks go back on 2026-11-01.
    expect(nextAfter({kind: 'weekly', weekday: 0}, '2026-10-25')).toBe('2026-11-01');
    expect(nextAfter({kind: 'weekly', weekday: 0}, '2026-11-01')).toBe('2026-11-08');
  });
});

describe('reading a schedule', () => {
  test('weekly, monthly and dates', () => {
    expect(parseSchedule('weekly:mon', NOW)).toEqual({ok: true, schedule: {kind: 'weekly', weekday: 1}});
    expect(parseSchedule('monthly:15', NOW)).toEqual({ok: true, schedule: {kind: 'monthly', day: 15}});
    expect(parseSchedule('2027-03-01', NOW)).toEqual({ok: true, schedule: {kind: 'once', date: '2027-03-01'}});
    expect(parseSchedule('fri', NOW)).toEqual({ok: true, schedule: {kind: 'once', date: '2026-09-25'}});
  });

  test('refuses what it cannot read', () => {
    expect(parseSchedule('weekly:someday', NOW).ok).toBe(false);
    expect(parseSchedule('monthly:32', NOW).ok).toBe(false);
    expect(parseSchedule('monthly:0', NOW).ok).toBe(false);
    expect(parseSchedule('whenever', NOW).ok).toBe(false);
    expect(asSchedule({kind: 'weekly', weekday: 7})).toBeUndefined();
    expect(asSchedule({kind: 'once', date: 'soon'})).toBeUndefined();
  });

  test('the text form round-trips, and the description reads well', () => {
    for (const s of [{kind: 'weekly', weekday: 5}, {kind: 'monthly', day: 2}, {kind: 'once', date: '2026-10-01'}] as Schedule[]) {
      expect(parseSchedule(scheduleText(s), NOW)).toEqual({ok: true, schedule: s});
    }
    expect(describeSchedule({kind: 'weekly', weekday: 1})).toBe('every Monday');
    expect(describeSchedule({kind: 'monthly', day: 22})).toBe('monthly on the 22nd');
    expect(describeSchedule({kind: 'monthly', day: 11})).toBe('monthly on the 11th');
    expect(describeSchedule({kind: 'once', date: '2026-10-01'})).toBe('once on Thu Oct 1');
  });
});
