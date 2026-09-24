/**
 * Promoting deferred tasks whose date has arrived.
 *
 * There used to be no daemon, so this ran at the start of every command. Now the server
 * runs it on a timer as well, which means a deferred task turns up in `next` on time
 * even when nobody runs anything.
 */
import {ACTOR_APP, planPromote} from '../core/mutation.ts';
import {readyToPromote} from '../core/tickler.ts';
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
