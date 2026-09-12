/**
 * One row of the task list.
 *
 * The title leads. It used to sit behind nine dim characters of task id, which is the
 * least interesting thing on the row and the first thing your eye hit; the id now shows
 * only for the row under the cursor, in the footer, where you can still copy it into a
 * shell command without paying for it on every line.
 *
 * The annotations that follow are measured before anything is drawn — see
 * `metaSegments` — so the title column is exactly as wide as it can be without pushing
 * the row over the terminal width. That is not fussiness: when a row overflows, Ink
 * reflows it and starts eating the spaces between words, and the whole list stops
 * lining up.
 *
 * Colour carries meaning and never carries it alone: an overdue task is red *and* says
 * `overdue 2d`, a dangling project link is amber *and* marked with a `?`. Terminals get
 * themed, piped, and read by people who cannot separate red from green.
 */
import React from 'react';
import {Box, Text} from 'ink';
import type {MetaSegment, Urgency} from '../../core/format.ts';
import type {TaskFile} from '../../core/types.ts';

export interface TaskRowProps {
  file: TaskFile;
  selected: boolean;
  /** Pre-measured, so every row in the list agrees on the layout. */
  meta: MetaSegment[];
  titleWidth: number;
  showState?: boolean;
}

const URGENCY_COLOUR: Record<Urgency, string | undefined> = {
  overdue: 'red',
  today: 'yellow',
  soon: 'yellow',
  later: undefined,
};

function Segment({segment}: {segment: MetaSegment}): React.ReactElement {
  // A tag or project reads better with its marker dimmed, so the word is what you see.
  if (segment.mark !== undefined) {
    const colour =
      segment.kind === 'project' ? (segment.dangling === true ? 'yellow' : 'magenta') : 'blue';
    return (
      <Text>
        <Text dimColor>{segment.mark}</Text>
        <Text color={colour}>{segment.text.slice(segment.mark.length)}</Text>
      </Text>
    );
  }

  if (segment.kind === 'due') {
    const urgency = segment.urgency ?? 'later';
    return (
      <Text color={URGENCY_COLOUR[urgency]} bold={urgency === 'overdue'}>
        {segment.text}
      </Text>
    );
  }

  if (segment.kind === 'waiting') return <Text color="yellow">{segment.text}</Text>;
  return <Text dimColor>{segment.text}</Text>;
}

export function TaskRow({
  file,
  selected,
  meta,
  titleWidth,
  showState = false,
}: TaskRowProps): React.ReactElement {
  const task = file.task;
  const title =
    task.title.length > titleWidth
      ? `${task.title.slice(0, Math.max(1, titleWidth - 1))}…`
      : task.title;

  return (
    <Box>
      <Text color={selected ? 'cyan' : undefined} bold={selected}>
        {selected ? '❯' : ' '}
      </Text>
      <Text> </Text>
      {showState && <Text dimColor>{task.state.padEnd(8)}</Text>}
      <Text bold={selected} color={selected ? 'cyan' : undefined}>
        {title.padEnd(titleWidth)}
      </Text>
      {meta.map((segment, index) => (
        <Text key={`${segment.kind}-${index}`}>
          <Text> </Text>
          <Segment segment={segment} />
        </Text>
      ))}
    </Box>
  );
}
