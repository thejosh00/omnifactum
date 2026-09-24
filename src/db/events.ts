/**
 * Telling open browsers what changed.
 *
 * Every committed write is recorded in the `events` table and then published here.
 * The table lets a browser that dropped its connection catch up from the last event it
 * saw; the hub is what makes the common case instant.
 *
 * The point is the same as it was in the terminal interface: when an agent completes a
 * task while you are looking at the list, the row should not just vanish. The event
 * says what happened and who did it.
 */
import type {Database} from 'bun:sqlite';
import type {Change, ChangeKind} from '../core/diff.ts';
import type {ProjectState, TaskState} from '../core/types.ts';

export type EventEntity = 'task' | 'project';

export interface StoredEvent {
  seq: number;
  accountId: number;
  at: string;
  /** What changed: a task, or a project. `change.id` is that thing's id. */
  entity: EventEntity;
  change: Change;
}

type Listener = (event: StoredEvent) => void;

export class EventHub {
  private readonly listeners = new Map<number, Set<Listener>>();

  subscribe(accountId: number, listener: Listener): () => void {
    const set = this.listeners.get(accountId) ?? new Set<Listener>();
    set.add(listener);
    this.listeners.set(accountId, set);
    return () => {
      set.delete(listener);
    };
  }

  publish(event: StoredEvent): void {
    for (const listener of this.listeners.get(event.accountId) ?? []) {
      try {
        listener(event);
      } catch {
        // One broken connection must not stop the others hearing about it.
      }
    }
  }
}

interface EventRow {
  seq: number;
  account_id: number;
  at: string;
  kind: string;
  task_id: string;
  title: string;
  from_state: string | null;
  to_state: string | null;
  actor: string | null;
  note: string | null;
  entity: string;
}

function toEvent(row: EventRow): StoredEvent {
  const change: Change = {kind: row.kind as ChangeKind, id: row.task_id, title: row.title};
  if (row.from_state !== null) change.from = row.from_state as TaskState | ProjectState;
  if (row.to_state !== null) change.to = row.to_state as TaskState | ProjectState;
  if (row.actor !== null) change.actor = row.actor;
  if (row.note !== null) change.note = row.note;
  return {seq: row.seq, accountId: row.account_id, at: row.at, entity: row.entity === 'project' ? 'project' : 'task', change};
}

/** Events after `seq`, oldest first, for a client catching up. */
export function eventsSince(db: Database, accountId: number, seq: number, limit = 500): StoredEvent[] {
  const rows = db
    .query('SELECT * FROM events WHERE account_id = ? AND seq > ? ORDER BY seq LIMIT ?')
    .all(accountId, seq, limit) as EventRow[];
  return rows.map(toEvent);
}

export function latestEventSeq(db: Database, accountId: number): number {
  const row = db
    .query('SELECT MAX(seq) AS seq FROM events WHERE account_id = ?')
    .get(accountId) as {seq: number | null};
  return row.seq ?? 0;
}

/** The wire shape of an event, for the browser and anyone else listening. */
export function eventToJson(event: StoredEvent): Record<string, unknown> {
  const {change} = event;
  const out: Record<string, unknown> = {
    seq: event.seq,
    at: event.at,
    entity: event.entity,
    kind: change.kind,
    id: change.id,
    title: change.title,
  };
  if (change.from !== undefined) out['from'] = change.from;
  if (change.to !== undefined) out['to'] = change.to;
  if (change.actor !== undefined) out['actor'] = change.actor;
  if (change.note !== undefined) out['note'] = change.note;
  return out;
}
