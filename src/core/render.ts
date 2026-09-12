/**
 * Plain-text output for the non-interactive commands.
 *
 * This output is for people. It is explicitly **not** a contract: an agent reads the
 * markdown files, which is why there is no `--json` anywhere in the app. Nothing here
 * should ever become something a script parses.
 */
import type {TaskFile, TaskState} from './types.ts';

/**
 * How much of an id to show.
 *
 * This must be longer than the 7-character time prefix, or two tasks captured in the
 * same second would display the same short id. Nine characters shows the timestamp
 * plus two of the random characters. Prefix resolution accepts anything unambiguous,
 * so a shorter one can still be typed.
 */
export const SHORT_ID_LENGTH = 9;

export function shortId(id: string): string {
  return id.slice(0, SHORT_ID_LENGTH);
}

function displayWidth(text: string): number {
  // Close enough for alignment: count wide CJK characters as two columns.
  let width = 0;
  for (const ch of text) {
    width += /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹯＀-｠￠-￦]/.test(ch)
      ? 2
      : 1;
  }
  return width;
}

function pad(text: string, width: number): string {
  const gap = width - displayWidth(text);
  return gap > 0 ? text + ' '.repeat(gap) : text;
}

export interface ListOptions {
  /** Show which state each task is in. Useful when a list spans several. */
  showState?: boolean;
  /** Text shown when there is nothing to list. */
  empty?: string;
}

export function renderTaskList(files: readonly TaskFile[], options: ListOptions = {}): string {
  if (files.length === 0) {
    return options.empty ?? 'Nothing here.';
  }

  const rows = files.map(file => {
    const task = file.task;
    const annotations: string[] = [];
    if (task.project !== undefined) annotations.push(`+${task.project}`);
    for (const tag of task.tags) annotations.push(`#${tag}`);
    if (task.due !== undefined) annotations.push(`due ${task.due}`);
    if (task.defer !== undefined) annotations.push(`deferred to ${task.defer}`);
    if (task.waitingOn !== undefined) annotations.push(`waiting on ${task.waitingOn}`);

    return {
      id: shortId(task.id),
      state: options.showState === true ? task.state : '',
      title: task.title,
      annotations: annotations.join(' '),
    };
  });

  const idWidth = Math.max(...rows.map(r => r.id.length));
  const stateWidth = Math.max(...rows.map(r => r.state.length));
  const titleWidth = Math.max(...rows.map(r => displayWidth(r.title)));

  return rows
    .map(row => {
      const parts = [pad(row.id, idWidth)];
      if (stateWidth > 0) parts.push(pad(row.state, stateWidth));
      parts.push(row.annotations.length > 0 ? pad(row.title, titleWidth) : row.title);
      if (row.annotations.length > 0) parts.push(row.annotations);
      return parts.join('  ').trimEnd();
    })
    .join('\n');
}

export function renderCounts(counts: Record<TaskState, number>): string {
  return (Object.entries(counts) as Array<[TaskState, number]>)
    .filter(([state]) => state !== 'done')
    .map(([state, count]) => `${state} ${count}`)
    .join('   ');
}

export function pluralize(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}
