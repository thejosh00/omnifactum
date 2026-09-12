/**
 * What the interactive interface is showing, as pure values.
 *
 * Everything a keypress does to the view lives here: which list is open, what the
 * filter says, which row is selected, and which slice of rows fits on screen. The Ink
 * components below this only render the result and forward keys, so the behaviour of
 * the interface is tested without rendering anything.
 *
 * Selection is tracked by task id rather than row index, because the list is rebuilt
 * from disk whenever anything changes — including changes an agent made in another
 * terminal — and an index would silently point at a different task.
 */
import {filterTasks, parseQuery} from './filter.ts';
import {isDeferred} from './tickler.ts';
import type {Snapshot} from './snapshot.ts';
import type {TaskFile, TaskState} from './types.ts';

/** The lists the interface can show, in the order the number keys select them. */
export const LISTS = ['inbox', 'next', 'waiting', 'someday', 'review', 'done'] as const;
export type ListName = (typeof LISTS)[number];

/** What is taking keyboard input. Only one thing at a time. */
export type Mode =
  | 'list'
  | 'filter'
  | 'capture'
  | 'tags'
  | 'note'
  | 'move'
  | 'clarify'
  | 'confirm-delete'
  | 'detail'
  | 'projects'
  | 'weekly'
  | 'help';

/**
 * Why a note is being typed, when `mode` is 'note'.
 *
 * One input row serves three jobs — finishing a task, sending one on with a reason, and
 * simply recording what happened — so what the note is *for* travels with the view.
 * Inferring it from the task instead would be wrong the moment someone else changed the
 * task while the row was open, and would attach the reason for a rejection to the wrong
 * event.
 */
export type NotePurpose =
  | {kind: 'complete'}
  | {kind: 'move'; to: TaskState}
  | {kind: 'log'};

export interface View {
  list: ListName;
  query: string;
  mode: Mode;
  /** The task the cursor is on, by id. Undefined when the list is empty. */
  selectedId?: string;
  /**
   * The task the detail view is pinned to, by id.
   *
   * Held separately from the cursor on purpose. If it followed the cursor, a task
   * completed by an agent while you were reading it would drop out of the current list,
   * the cursor would move to a neighbour, and the detail view would silently start
   * showing a different task's fields under the same heading — the sort of thing that
   * gets someone to act on the wrong task.
   */
  detailId?: string;
  /** Show tasks whose defer date has not arrived. */
  showDeferred: boolean;
  /** Scratch text for whichever input mode is active. */
  input: string;
  /** What the note being typed is for. Only read while `mode` is 'note'. */
  notePurpose?: NotePurpose;
  /** Which step of the weekly review is showing, when one is running. */
  weeklyStep?: number;
  /** A transient one-line message, such as "updated on disk". */
  banner?: string;
}

export function initialView(list: ListName = 'next'): View {
  return {list, query: '', mode: 'list', showDeferred: false, input: ''};
}

/**
 * The rows to show: the chosen list, narrowed by the filter, with deferred tasks
 * hidden unless asked for.
 */
export function visibleTasks(snapshot: Snapshot, view: View, nowIso: string): TaskFile[] {
  const inList = snapshot.byState.get(view.list) ?? [];
  const {query} = parseQuery(view.query);
  const matched = filterTasks(inList, query, {nowIso});

  const rows = view.showDeferred
    ? matched
    : matched.filter(file => !isDeferred(file.task, nowIso));

  // Completed tasks read best newest-first; everything else in creation order.
  return view.list === 'done' ? [...rows].reverse() : rows;
}

export function indexOfSelection(rows: readonly TaskFile[], selectedId: string | undefined): number {
  if (selectedId === undefined) return rows.length > 0 ? 0 : -1;
  const index = rows.findIndex(file => file.task.id === selectedId);
  return index === -1 ? (rows.length > 0 ? 0 : -1) : index;
}

export function selectedTask(
  rows: readonly TaskFile[],
  selectedId: string | undefined,
): TaskFile | undefined {
  const index = indexOfSelection(rows, selectedId);
  return index === -1 ? undefined : rows[index];
}

/** Move the cursor by `delta` rows, clamped at both ends rather than wrapping. */
export function moveSelection(
  rows: readonly TaskFile[],
  selectedId: string | undefined,
  delta: number,
): string | undefined {
  if (rows.length === 0) return undefined;
  const current = indexOfSelection(rows, selectedId);
  const next = Math.min(rows.length - 1, Math.max(0, current + delta));
  return rows[next]?.task.id;
}

export function selectFirst(rows: readonly TaskFile[]): string | undefined {
  return rows[0]?.task.id;
}

export function selectLast(rows: readonly TaskFile[]): string | undefined {
  return rows[rows.length - 1]?.task.id;
}

/**
 * Keep the selection on screen after the list is rebuilt.
 *
 * When the selected task has gone — an agent completed it, or the filter no longer
 * matches it — the cursor lands on whatever is now in that position rather than
 * jumping to the top, which is what makes an agent working alongside you unobtrusive.
 */
export function reconcileSelection(
  rows: readonly TaskFile[],
  previousRows: readonly TaskFile[],
  selectedId: string | undefined,
): string | undefined {
  if (rows.length === 0) return undefined;
  if (selectedId !== undefined && rows.some(file => file.task.id === selectedId)) {
    return selectedId;
  }

  const previousIndex = previousRows.findIndex(file => file.task.id === selectedId);
  if (previousIndex === -1) return rows[0]?.task.id;

  return rows[Math.min(previousIndex, rows.length - 1)]?.task.id;
}

export interface Window {
  start: number;
  end: number;
}

/**
 * Which slice of rows to render.
 *
 * Ink re-renders its whole tree and has no virtualization, so a thousand-row list is
 * visibly slow if it is all mounted. Only the visible slice is ever built.
 */
export function windowRange(total: number, selected: number, height: number): Window {
  const size = Math.max(1, height);
  if (total <= size) return {start: 0, end: total};

  const cursor = Math.max(0, selected);
  // Keep a row of context above and below the cursor where there is room for it.
  const margin = size >= 5 ? 1 : 0;

  let start = Math.min(cursor - margin, total - size);
  start = Math.max(0, Math.min(start, cursor));
  if (cursor >= start + size - margin) start = cursor - size + 1 + margin;

  start = Math.max(0, Math.min(start, total - size));
  return {start, end: start + size};
}

/** A short description of what is being shown, for the status line. */
export function describeView(view: View, shown: number, total: number): string {
  const parts = [`${view.list} ${shown}`];
  if (shown !== total) parts.push(`of ${total}`);
  if (view.query.trim().length > 0) parts.push(`filter: ${view.query.trim()}`);
  if (view.showDeferred) parts.push('including deferred');
  return parts.join('  ');
}
