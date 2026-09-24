/**
 * The keyboard map, as data. The help overlay renders this table and the handler looks
 * intents up in it, so a key cannot be documented and not work, or work undocumented.
 *
 * The letters are the ones the terminal interface used, so muscle memory carries over.
 */
import {TASK_STATES, type TaskState} from '../core/types.ts';

export type Intent =
  | 'down'
  | 'up'
  | 'top'
  | 'bottom'
  | 'open'
  | 'close'
  | 'complete'
  | 'capture'
  | 'tags'
  | 'note'
  | 'move'
  | 'clarify'
  | 'projects'
  | 'tickler'
  | 'weekly'
  | 'step-next'
  | 'step-back'
  | 'delete'
  | 'filter'
  | 'help'
  | `list:${TaskState}`;

export interface Binding {
  keys: string[];
  label: string;
  intent: Intent;
  group: 'Moving' | 'Acting' | 'Lists';
}

export const BINDINGS: Binding[] = [
  {keys: ['j', 'ArrowDown'], label: 'next task', intent: 'down', group: 'Moving'},
  {keys: ['k', 'ArrowUp'], label: 'previous task', intent: 'up', group: 'Moving'},
  {keys: ['g'], label: 'first task', intent: 'top', group: 'Moving'},
  {keys: ['G'], label: 'last task', intent: 'bottom', group: 'Moving'},
  {keys: ['Enter', 'o'], label: 'open the task', intent: 'open', group: 'Moving'},
  {keys: ['Escape'], label: 'close, or clear the filter', intent: 'close', group: 'Moving'},
  {keys: ['x'], label: 'complete (accept, in review)', intent: 'complete', group: 'Acting'},
  {keys: ['c'], label: 'capture into the inbox', intent: 'capture', group: 'Acting'},
  {keys: ['t'], label: 'edit tags', intent: 'tags', group: 'Acting'},
  {keys: ['N'], label: 'record what happened', intent: 'note', group: 'Acting'},
  {keys: ['m'], label: 'move to another list', intent: 'move', group: 'Acting'},
  {keys: ['C'], label: 'clarify (the whole inbox, from the inbox)', intent: 'clarify', group: 'Acting'},
  {keys: ['X'], label: 'delete permanently', intent: 'delete', group: 'Acting'},
  {keys: ['/'], label: 'filter by tag or text', intent: 'filter', group: 'Lists'},
  {keys: ['p'], label: 'projects', intent: 'projects', group: 'Lists'},
  {keys: ['T'], label: 'tickler', intent: 'tickler', group: 'Lists'},
  {keys: ['W'], label: 'start or leave the weekly review', intent: 'weekly', group: 'Lists'},
  {keys: ['n'], label: 'next step of the review', intent: 'step-next', group: 'Lists'},
  {keys: ['b'], label: 'previous step of the review', intent: 'step-back', group: 'Lists'},
  ...TASK_STATES.map(
    (state, index): Binding => ({keys: [String(index + 1)], label: state, intent: `list:${state}`, group: 'Lists'}),
  ),
  {keys: ['?'], label: 'this help', intent: 'help', group: 'Lists'},
];

const BY_KEY = new Map<string, Intent>(BINDINGS.flatMap(binding => binding.keys.map(key => [key, binding.intent] as const)));

export function intentFor(event: KeyboardEvent): Intent | undefined {
  if (event.metaKey || event.ctrlKey || event.altKey) return undefined;
  return BY_KEY.get(event.key);
}

/** How a key is shown in the help. */
export function keyLabel(key: string): string {
  return {ArrowDown: '↓', ArrowUp: '↑', Escape: 'esc', Enter: 'enter'}[key] ?? key;
}
