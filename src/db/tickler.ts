/**
 * The tickler: things that surface in `next` when their day comes.
 *
 * Two kinds. A deferred task waits in `someday` and is promoted when its defer date
 * arrives. A tickler item is a schedule — every Monday, the 15th, once on a date — that
 * creates a fresh next action tagged `#tickler` each time it fires.
 *
 * There used to be no daemon, so this ran at the start of every command. Now the server
 * runs it on a timer as well, which means both turn up on time even when nobody runs
 * anything.
 */
import {ACTOR_APP, planNewTask, planPromote} from '../core/mutation.ts';
import {describeSchedule, firstOn, nextAfter, TICKLER_TAG, type Schedule, type TicklerFile} from '../core/recurrence.ts';
import {readyToPromote} from '../core/tickler.ts';
import {todayIso} from '../core/time.ts';
import type {Store} from './store.ts';

/** Promote whatever is due, in one transaction. Returns how many moved. */
export function sweepTickler(store: Store, nowIso: string): number {
  const app = store.as(ACTOR_APP);
  return app.batch(() => {
    let promoted = 0;
    for (const file of readyToPromote(app.load().tasks, nowIso)) {
      const result = app.updateTask(file.task.id, task => planPromote(task, {nowIso}));
      if (result.kind === 'ok') promoted += 1;
    }
    return promoted;
  });
}

/** Start a tickler item. One that is already due fires straight away rather than at the next sweep. */
export function createTickler(store: Store, title: string, schedule: Schedule, nowIso: string): TicklerFile {
  const trimmed = title.trim();
  if (trimmed.length === 0) throw new Error('a tickler item needs a title');
  return store.batch(() => {
    const created = store.createTickler({
      id: store.mintId(),
      title: trimmed,
      schedule,
      nextOn: firstOn(schedule, todayIso(nowIso)),
      created: nowIso,
    });
    sweepRecurring(store, nowIso);
    return store.getTickler(created.tickler.id) ?? created;
  });
}

/**
 * Fire every tickler item whose day has come, in one transaction. Returns how many
 * tasks were created.
 *
 * Two rules keep `next` from filling up. Missed firings collapse: after a week with the
 * server off, a weekly item makes one task, not one per missed Monday, and then waits for
 * the next Monday after today. And firings do not stack: while the task from the last
 * firing is still open, a firing makes nothing, and the schedule simply moves on.
 */
export function sweepRecurring(store: Store, nowIso: string): number {
  const app = store.as(ACTOR_APP);
  const today = todayIso(nowIso);
  return app.batch(() => {
    let created = 0;
    for (const {tickler} of app.listTicklers()) {
      if (tickler.nextOn > today) continue;

      const previous = tickler.lastTaskId === undefined ? undefined : app.getTask(tickler.lastTaskId);
      let lastTaskId = tickler.lastTaskId;
      if (previous === undefined || previous.task.state === 'done') {
        const task = planNewTask({
          id: app.mintId(),
          title: tickler.title,
          state: 'next',
          tags: [TICKLER_TAG],
          nowIso,
          actor: ACTOR_APP,
          note: `From the tickler: ${describeSchedule(tickler.schedule)}.`,
        });
        if (app.createTask(task).kind === 'ok') {
          created += 1;
          lastTaskId = task.id;
        }
      }

      const following = nextAfter(tickler.schedule, today);
      if (following === undefined) {
        app.removeTickler(tickler.id);
      } else {
        app.updateTickler(tickler.id, current => ({
          ...current,
          nextOn: following,
          ...(lastTaskId === undefined ? {} : {lastTaskId}),
        }));
      }
    }
    return created;
  });
}

/** Find a tickler item by id or unique id prefix. */
export function findTickler(store: Store, ref: string): TicklerFile | {ambiguous: TicklerFile[]} | undefined {
  const needle = ref.trim().toLowerCase();
  if (needle.length === 0) return undefined;
  const all = store.listTicklers();
  const exact = all.find(file => file.tickler.id === needle);
  if (exact !== undefined) return exact;
  const matches = all.filter(file => file.tickler.id.startsWith(needle));
  if (matches.length === 1) return matches[0];
  return matches.length > 1 ? {ambiguous: matches} : undefined;
}

/**
 * Change a tickler item's title or schedule. A new schedule starts from today, so moving
 * "every Monday" to "every Friday" means this Friday, not whenever Monday's would have been.
 */
export function editTickler(
  store: Store,
  id: string,
  edit: {title?: string; schedule?: Schedule},
  nowIso: string,
  expectVersion?: number,
) {
  const title = edit.title?.trim();
  if (title !== undefined && title.length === 0) throw new Error('a tickler item needs a title');
  return store.batch(() => {
    const result = store.updateTickler(
      id,
      current => ({
        ...current,
        ...(title === undefined ? {} : {title}),
        ...(edit.schedule === undefined ? {} : {schedule: edit.schedule, nextOn: firstOn(edit.schedule, todayIso(nowIso))}),
      }),
      expectVersion === undefined ? {} : {expectVersion},
    );
    if (result.kind === 'ok' && edit.schedule !== undefined) {
      sweepRecurring(store, nowIso);
      const fresh = store.getTickler(id);
      // A one-off moved to today fires and is gone; report what it was.
      return fresh === undefined ? result : {kind: 'ok' as const, file: fresh};
    }
    return result;
  });
}
