import {describe, expect, test} from 'bun:test';
import {planComplete} from '../../src/core/mutation.ts';
import {findAccount, openDatabase} from '../../src/db/database.ts';
import {EventHub} from '../../src/db/events.ts';
import {Store} from '../../src/db/store.ts';
import {createTickler, editTickler, sweepRecurring} from '../../src/db/tickler.ts';

// Wednesday 2026-09-23 in Chicago.
const WED = '2026-09-23T15:00:00Z';
const at = (day: string) => `${day}T15:00:00Z`;

function setup() {
  const db = openDatabase(':memory:');
  let n = 0;
  const mint = () => `1nab5wap${String(n++).padStart(4, '0')}`;
  const store = new Store(db, findAccount(db, 'work')!, {actor: 'you', hub: new EventHub(), now: () => WED, mint});
  const tickled = () => store.load().tasks.filter(f => f.task.tags.includes('tickler'));
  return {store, tickled};
}

describe('the recurring tickler', () => {
  test('an item due today fires as soon as it is added, once, into next with #tickler', () => {
    const {store, tickled} = setup();
    const file = createTickler(store, 'Put the recycling out', {kind: 'weekly', weekday: 3}, WED);

    expect(tickled().map(f => [f.task.title, f.task.state])).toEqual([['Put the recycling out', 'next']]);
    expect(tickled()[0]!.task.log.at(-1)!.text).toBe('From the tickler: every Wednesday.');
    expect(file.tickler.nextOn).toBe('2026-09-30');

    expect(sweepRecurring(store, WED)).toBe(0);
    expect(tickled()).toHaveLength(1);
  });

  test('an item for a later day waits for it', () => {
    const {store, tickled} = setup();
    createTickler(store, 'Pay the water bill', {kind: 'monthly', day: 15}, WED);
    expect(tickled()).toHaveLength(0);
    expect(sweepRecurring(store, at('2026-10-14'))).toBe(0);
    expect(sweepRecurring(store, at('2026-10-15'))).toBe(1);
  });

  test('while the last one is still open, a firing adds nothing but the schedule moves on', () => {
    const {store, tickled} = setup();
    const file = createTickler(store, 'Recycling', {kind: 'weekly', weekday: 3}, WED);

    expect(sweepRecurring(store, at('2026-09-30'))).toBe(0);
    expect(tickled()).toHaveLength(1);
    expect(store.getTickler(file.tickler.id)!.tickler.nextOn).toBe('2026-10-07');

    // Done now: the next firing brings a fresh one.
    store.updateTask(tickled()[0]!.task.id, task => planComplete(task, {nowIso: at('2026-10-01')}));
    expect(sweepRecurring(store, at('2026-10-07'))).toBe(1);
    expect(tickled().filter(f => f.task.state === 'next')).toHaveLength(1);
  });

  test('a deleted task counts as finished, not as open', () => {
    const {store, tickled} = setup();
    createTickler(store, 'Recycling', {kind: 'weekly', weekday: 3}, WED);
    store.removeTask(tickled()[0]!.task.id);
    expect(sweepRecurring(store, at('2026-09-30'))).toBe(1);
  });

  test('missed firings make one task, then wait for the next one after today', () => {
    const {store, tickled} = setup();
    const file = createTickler(store, 'Recycling', {kind: 'weekly', weekday: 1}, WED);
    // Server off from Monday 28 Sep to Thursday 15 Oct: three Mondays missed.
    expect(sweepRecurring(store, at('2026-10-15'))).toBe(1);
    expect(tickled()).toHaveLength(1);
    expect(store.getTickler(file.tickler.id)!.tickler.nextOn).toBe('2026-10-19');
  });

  test('a one-off fires once and is gone', () => {
    const {store, tickled} = setup();
    const file = createTickler(store, 'Renew the passport', {kind: 'once', date: '2026-10-01'}, WED);
    expect(sweepRecurring(store, at('2026-10-01'))).toBe(1);
    expect(store.getTickler(file.tickler.id)).toBeUndefined();
    expect(sweepRecurring(store, at('2026-10-08'))).toBe(0);
    expect(tickled()).toHaveLength(1);
  });

  test('changing the schedule starts it again from today', () => {
    const {store} = setup();
    const file = createTickler(store, 'Recycling', {kind: 'weekly', weekday: 1}, WED);
    const result = editTickler(store, file.tickler.id, {schedule: {kind: 'weekly', weekday: 5}}, WED);
    expect(result.kind === 'ok' && result.file.tickler.nextOn).toBe('2026-09-25');
  });
});
