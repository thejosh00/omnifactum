/**
 * The task list.
 *
 * Only the visible slice is ever rendered. Ink re-renders its whole tree and has no
 * virtualization, so mounting a thousand rows to show twenty of them is visibly slow.
 *
 * The layout is measured before it is drawn. Each row's annotations are built once, the
 * widest set among the visible rows decides the title column, and every title then
 * starts and ends in the same place. Guessing a column width instead makes long rows
 * overflow, and an overflowing row in Ink does not clip — it reflows, swallowing the
 * spaces between words until the list stops lining up.
 */
import React, {useMemo} from 'react';
import {Box, Text} from 'ink';
import {metaSegments, metaWidth} from '../../core/format.ts';
import {isDeferred} from '../../core/tickler.ts';
import {EmptyState} from '../components/StatusBar.tsx';
import {TaskRow} from '../components/TaskRow.tsx';
import {windowRange} from '../../core/view.ts';
import type {TaskFile} from '../../core/types.ts';

export interface ListScreenProps {
  rows: TaskFile[];
  selectedIndex: number;
  height: number;
  width: number;
  nowIso: string;
  empty: string;
  /** A nudge shown under the empty message, saying what to do about it. */
  emptyHint?: string | undefined;
  /** Ids of tasks whose project reference does not resolve. */
  dangling: Set<string>;
  showState?: boolean;
}

/** The cursor column, its trailing space, and a gap before the annotations. */
const CHROME = 3;
const MIN_TITLE = 18;
const MAX_TITLE = 56;

export function ListScreen({
  rows,
  selectedIndex,
  height,
  width,
  nowIso,
  empty,
  emptyHint,
  dangling,
  showState = false,
}: ListScreenProps): React.ReactElement {
  const {start, end} = windowRange(rows.length, selectedIndex, height);

  const laid = useMemo(() => {
    const visible = rows.slice(start, end);
    const meta = visible.map(file =>
      metaSegments(
        {
          tags: file.task.tags,
          project: file.task.project,
          due: file.task.due,
          defer: file.task.defer,
          waitingOn: file.task.waitingOn,
        },
        nowIso,
        {dangling: dangling.has(file.task.id), deferred: isDeferred(file.task, nowIso)},
      ),
    );

    const widest = meta.reduce((most, segments) => Math.max(most, metaWidth(segments)), 0);
    const stateColumn = showState ? 8 : 0;
    const available = width - CHROME - stateColumn - widest;
    const titleWidth = Math.max(MIN_TITLE, Math.min(MAX_TITLE, available));

    return {visible, meta, titleWidth};
  }, [rows, start, end, nowIso, dangling, width, showState]);

  if (rows.length === 0) {
    return <EmptyState message={empty} {...(emptyHint === undefined ? {} : {hint: emptyHint})} />;
  }

  return (
    <Box flexDirection="column">
      {start > 0 && <Text dimColor>  ↑ {start} more above</Text>}
      {laid.visible.map((file, index) => (
        <TaskRow
          key={file.task.id}
          file={file}
          selected={start + index === selectedIndex}
          meta={laid.meta[index] ?? []}
          titleWidth={laid.titleWidth}
          showState={showState}
        />
      ))}
      {end < rows.length && <Text dimColor>  ↓ {rows.length - end} more below</Text>}
    </Box>
  );
}
