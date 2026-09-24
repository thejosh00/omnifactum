import {describe, expect, test} from 'bun:test';
import {findAccount, openDatabase} from '../../src/db/database.ts';
import {EventHub, eventsSince, type StoredEvent} from '../../src/db/events.ts';
import {Store} from '../../src/db/store.ts';
import {sweepTickler} from '../../src/db/tickler.ts';
import {planAddTags, planComplete, planMove, planNewTask, planNote, planSetTitle} from '../../src/core/mutation.ts';

const NOW = '2026-09-23T10:00:00Z';

function setup() {
  const db = openDatabase(':memory:');
  const hub = new EventHub();
  const work = findAccount(db, 'work')!;
  const home = findAccount(db, 'home')!;
  let n = 0;
  const mint = () => `1nab5wap${String(n++).padStart(4, '0')}`;
  const store = (account = work, actor = 'you') => new Store(db, account, {actor, hub, now: () => NOW, mint});
  return {db, hub, work, home, store};
}

function add(store: Store, title: string, state: 'next' | 'someday' = 'next', extra: {defer?: string} = {}) {
  const result = store.createTask(planNewTask({id: store.mintId(), title, state, nowIso: NOW, ...extra}));
  if (result.kind !== 'ok') throw new Error(result.kind);
  return result.file;
}

describe('the database store', () => {
  test('starts with a work and a home account', () => {
    const {db} = setup();
    expect(findAccount(db, 'work')).toBeDefined();
    expect(findAccount(db, 'home')).toBeDefined();
  });

  test('a created task reads back whole, log included', () => {
    const {store} = setup();
    const s = store();
    const file = add(s, 'Fix the printer driver');
    s.updateTask(file.task.id, task => planNote(task, {nowIso: NOW, note: 'checked the cable'}));

    const loaded = s.load().byId.get(file.task.id)!;
    expect(loaded.stem).toBe('fix-the-printer-driver');
    expect(loaded.version).toBe(2);
    expect(loaded.task.log.map(e => e.text)).toEqual(['checked the cable']);
  });

  test('accounts never see each other\'s tasks', () => {
    const {store, home} = setup();
    add(store(), 'Quarterly report');
    add(store(home), 'Mow the lawn');

    expect(store().load().tasks.map(f => f.task.title)).toEqual(['Quarterly report']);
    expect(store(home).load().tasks.map(f => f.task.title)).toEqual(['Mow the lawn']);
  });

  test('a stem stays unique within an account and follows an app-chosen title', () => {
    const {store} = setup();
    const s = store();
    const a = add(s, 'Call Sam');
    const b = add(s, 'Call Sam');
    expect(a.stem).not.toBe(b.stem);

    const renamed = s.updateTask(a.task.id, task => planSetTitle(task, 'Call Sam back'));
    expect(renamed.kind === 'ok' && renamed.file.stem).toBe('call-sam-back');
  });

  test('a planner sees the row as it is now, not the caller\'s copy', () => {
    const {store} = setup();
    const person = store();
    const agent = store(undefined, 'agent:claude-code');
    const file = add(person, 'Order tiles');

    agent.updateTask(file.task.id, task => planAddTags(task, ['agent']));
    // The person acts on a stale copy; completion still keeps the agent's tag.
    person.updateTask(file.task.id, task => planComplete(task, {nowIso: NOW}));

    const after = person.getTask(file.task.id)!;
    expect(after.task.state).toBe('done');
    expect(after.task.tags).toEqual(['agent']);
  });

  test('an edit against a stale version is refused and handed the current row', () => {
    const {store} = setup();
    const s = store();
    const file = add(s, 'Draft the memo');
    s.updateTask(file.task.id, task => planNote(task, {nowIso: NOW, note: 'agent was here'}));

    const result = s.updateTask(file.task.id, task => ({...task, body: 'mine'}), {expectVersion: file.version});
    expect(result.kind).toBe('stale');
    expect(result.kind === 'stale' && result.file.version).toBe(2);
    expect(s.getTask(file.task.id)!.task.body).toBe('');
  });

  test('a planner that throws changes nothing', () => {
    const {store} = setup();
    const s = store();
    const file = add(s, 'Leave me alone');
    const result = s.updateTask(file.task.id, () => {
      throw new Error('nope');
    });
    expect(result).toEqual({kind: 'failed', reason: 'nope'});
    expect(s.getTask(file.task.id)!.version).toBe(1);
  });

  test('a batch that throws rolls back and announces nothing', () => {
    const {store, hub, work} = setup();
    const heard: StoredEvent[] = [];
    hub.subscribe(work.id, event => heard.push(event));
    const s = store();
    const file = add(s, 'Keep me');
    heard.length = 0;

    expect(() =>
      s.batch(() => {
        s.updateTask(file.task.id, task => planMove(task, 'someday', {nowIso: NOW}));
        throw new Error('changed my mind');
      }),
    ).toThrow('changed my mind');

    expect(s.getTask(file.task.id)!.task.state).toBe('next');
    expect(heard).toEqual([]);
  });

  test('every committed change is announced with who made it', () => {
    const {store, hub, work, home, db} = setup();
    const heard: StoredEvent[] = [];
    hub.subscribe(work.id, event => heard.push(event));

    const agent = store(undefined, 'agent:claude-code');
    const file = add(agent, 'Fix printer');
    agent.updateTask(file.task.id, task => planMove(task, 'review', {nowIso: NOW, note: 'installed PPD'}));
    add(store(home), 'Not for work ears');

    expect(heard.map(e => [e.change.kind, e.change.actor, e.change.note])).toEqual([
      ['added', 'agent:claude-code', undefined],
      ['moved', 'agent:claude-code', 'installed PPD'],
    ]);
    // And it is there for a browser that reconnects later.
    expect(eventsSince(db, work.id, heard[0]!.seq).map(e => e.change.kind)).toEqual(['moved']);
  });

  test('the tickler promotes arrived deferrals as omni', () => {
    const {store} = setup();
    const s = store();
    const file = add(s, 'Renew passport', 'someday', {defer: '2026-09-01'});
    add(s, 'Later', 'someday', {defer: '2027-01-01'});

    expect(sweepTickler(s, NOW)).toBe(1);
    const promoted = s.getTask(file.task.id)!.task;
    expect(promoted.state).toBe('next');
    expect(promoted.log.at(-1)!.actor).toBe('omni');
    expect(sweepTickler(s, NOW)).toBe(0);
  });

  test('deleting a task takes its log with it', () => {
    const {store, db} = setup();
    const s = store();
    const file = add(s, 'Gone soon');
    s.updateTask(file.task.id, task => planNote(task, {nowIso: NOW, note: 'x'}));
    expect(s.removeTask(file.task.id).kind).toBe('ok');
    expect(s.getTask(file.task.id)).toBeUndefined();
    expect((db.query('SELECT COUNT(*) AS n FROM task_log').get() as {n: number}).n).toBe(0);
  });
});
