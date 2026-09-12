/**
 * The keyboard map, as data rather than as a switch statement.
 *
 * The help screen renders this table and the tests iterate it, so the keys, the help
 * text, and the behaviour cannot drift apart. Adding a key here and forgetting to
 * document it is not possible.
 */
import type {Mode} from '../core/view.ts';

/** Everything a keypress can ask for. The UI never decides what these mean. */
export type Intent =
  | 'move-down'
  | 'move-up'
  | 'page-down'
  | 'page-up'
  | 'go-top'
  | 'go-bottom'
  | 'open'
  | 'back'
  | 'complete'
  | 'capture'
  | 'clarify'
  | 'edit-tags'
  | 'note'
  | 'move-state'
  | 'open-editor'
  | 'delete'
  | 'focus-filter'
  | 'clear-filter'
  | 'toggle-deferred'
  | 'list-inbox'
  | 'list-next'
  | 'list-waiting'
  | 'list-someday'
  | 'list-review'
  | 'list-done'
  | 'projects'
  | 'weekly'
  | 'step-next'
  | 'step-back'
  | 'refresh'
  | 'help'
  | 'quit';

export interface Binding {
  /** How the key is written in help. */
  keys: string;
  intent: Intent;
  label: string;
  /** Which modes it applies in. */
  modes: Mode[];
  /** Grouping for the help screen. */
  group: 'moving' | 'acting' | 'filtering' | 'lists' | 'other';
}

export const BINDINGS: Binding[] = [
  {keys: 'j / ↓', intent: 'move-down', label: 'next row', modes: ['list', 'projects', 'weekly'], group: 'moving'},
  {keys: 'k / ↑', intent: 'move-up', label: 'previous row', modes: ['list', 'projects', 'weekly'], group: 'moving'},
  {keys: 'ctrl-d', intent: 'page-down', label: 'down a page', modes: ['list', 'projects'], group: 'moving'},
  {keys: 'ctrl-u', intent: 'page-up', label: 'up a page', modes: ['list', 'projects'], group: 'moving'},
  {keys: 'g', intent: 'go-top', label: 'first row', modes: ['list', 'projects'], group: 'moving'},
  {keys: 'G', intent: 'go-bottom', label: 'last row', modes: ['list', 'projects'], group: 'moving'},

  {keys: 'enter', intent: 'open', label: 'open the task', modes: ['list', 'projects', 'weekly'], group: 'acting'},
  {keys: 'x', intent: 'complete', label: 'complete, with a note', modes: ['list', 'detail', 'weekly'], group: 'acting'},
  {keys: 'c', intent: 'capture', label: 'capture into the inbox', modes: ['list', 'detail', 'projects'], group: 'acting'},
  {keys: 'C', intent: 'clarify', label: 'clarify it, question by question', modes: ['list', 'detail', 'weekly'], group: 'acting'},
  {keys: 't', intent: 'edit-tags', label: 'edit tags', modes: ['list', 'detail', 'weekly'], group: 'acting'},
  {keys: 'N', intent: 'note', label: 'record what happened', modes: ['list', 'detail', 'weekly'], group: 'acting'},
  {keys: 'm', intent: 'move-state', label: 'move to another list', modes: ['list', 'detail', 'weekly'], group: 'acting'},
  {keys: 'e', intent: 'open-editor', label: 'open in $EDITOR', modes: ['list', 'detail', 'weekly'], group: 'acting'},
  // Deliberately a capital, and not next to anything common: there is no undo.
  {keys: 'X', intent: 'delete', label: 'delete permanently', modes: ['list', 'detail', 'weekly'], group: 'acting'},

  {keys: '/', intent: 'focus-filter', label: 'filter by tag or text', modes: ['list'], group: 'filtering'},
  {keys: 'esc', intent: 'clear-filter', label: 'clear the filter', modes: ['list'], group: 'filtering'},
  {keys: '.', intent: 'toggle-deferred', label: 'show deferred tasks', modes: ['list'], group: 'filtering'},

  {keys: '1', intent: 'list-inbox', label: 'inbox', modes: ['list', 'detail', 'projects'], group: 'lists'},
  {keys: '2', intent: 'list-next', label: 'next', modes: ['list', 'detail', 'projects'], group: 'lists'},
  {keys: '3', intent: 'list-waiting', label: 'waiting', modes: ['list', 'detail', 'projects'], group: 'lists'},
  {keys: '4', intent: 'list-someday', label: 'someday', modes: ['list', 'detail', 'projects'], group: 'lists'},
  {keys: '5', intent: 'list-review', label: 'review', modes: ['list', 'detail', 'projects'], group: 'lists'},
  {keys: '6', intent: 'list-done', label: 'done', modes: ['list', 'detail', 'projects'], group: 'lists'},
  {keys: 'p', intent: 'projects', label: 'projects', modes: ['list', 'detail', 'projects'], group: 'lists'},

  {keys: 'W', intent: 'weekly', label: 'walk the weekly review', modes: ['list', 'projects'], group: 'other'},
  {keys: 'n', intent: 'step-next', label: 'next step of the review', modes: ['weekly'], group: 'other'},
  {keys: 'b', intent: 'step-back', label: 'previous step', modes: ['weekly'], group: 'other'},

  {keys: 'r', intent: 'refresh', label: 'reread from disk', modes: ['list', 'detail', 'projects', 'weekly'], group: 'other'},
  {keys: '?', intent: 'help', label: 'this help', modes: ['list', 'detail', 'projects', 'weekly'], group: 'other'},
  {keys: 'q', intent: 'quit', label: 'quit', modes: ['list', 'detail', 'projects', 'weekly'], group: 'other'},
];

export interface KeyEvent {
  input: string;
  upArrow?: boolean;
  downArrow?: boolean;
  leftArrow?: boolean;
  rightArrow?: boolean;
  return?: boolean;
  escape?: boolean;
  ctrl?: boolean;
  tab?: boolean;
  backspace?: boolean;
  delete?: boolean;
}

/**
 * Which intent a keypress means in a given mode, or undefined if it means nothing.
 * Pure, so every row of the table above is a cheap test.
 */
export function intentFor(event: KeyEvent, mode: Mode): Intent | undefined {
  const allowed = (intent: Intent): Intent | undefined =>
    BINDINGS.some(b => b.intent === intent && b.modes.includes(mode)) ? intent : undefined;

  if (event.ctrl && event.input === 'd') return allowed('page-down');
  if (event.ctrl && event.input === 'u') return allowed('page-up');
  if (event.downArrow) return allowed('move-down');
  if (event.upArrow) return allowed('move-up');
  if (event.return) return allowed('open');
  if (event.escape) return mode === 'list' ? allowed('clear-filter') : 'back';

  switch (event.input) {
    case 'j':
      return allowed('move-down');
    case 'k':
      return allowed('move-up');
    case 'g':
      return allowed('go-top');
    case 'G':
      return allowed('go-bottom');
    case 'x':
      return allowed('complete');
    case 'c':
      return allowed('capture');
    case 'C':
      return allowed('clarify');
    case 't':
      return allowed('edit-tags');
    case 'N':
      return allowed('note');
    case 'm':
      return allowed('move-state');
    case 'e':
      return allowed('open-editor');
    case 'X':
      return allowed('delete');
    case '/':
      return allowed('focus-filter');
    case '.':
      return allowed('toggle-deferred');
    case '1':
      return allowed('list-inbox');
    case '2':
      return allowed('list-next');
    case '3':
      return allowed('list-waiting');
    case '4':
      return allowed('list-someday');
    case '5':
      return allowed('list-review');
    case '6':
      return allowed('list-done');
    case 'p':
      return allowed('projects');
    case 'W':
      return allowed('weekly');
    case 'n':
      return allowed('step-next');
    case 'b':
      return allowed('step-back');
    case 'r':
      return allowed('refresh');
    case '?':
      return allowed('help');
    case 'q':
      return allowed('quit');
    default:
      return undefined;
  }
}

export function bindingsFor(mode: Mode): Binding[] {
  return BINDINGS.filter(binding => binding.modes.includes(mode));
}

export const GROUP_TITLES: Record<Binding['group'], string> = {
  moving: 'Moving around',
  acting: 'Acting on a task',
  filtering: 'Narrowing the list',
  lists: 'Switching lists',
  other: 'Other',
};
