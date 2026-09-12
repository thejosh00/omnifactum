/**
 * One task, in full: its fields, its prose, and its log.
 *
 * The log is worth showing prominently. It is where an agent says what it did, and
 * reading that back is most of the point of letting an agent touch these files.
 */
import React from 'react';
import {Box, Text} from 'ink';
import {isOverdue} from '../../core/tickler.ts';
import type {TaskFile} from '../../core/types.ts';

export interface DetailScreenProps {
  file: TaskFile;
  nowIso: string;
  height: number;
  /** True when the task's project reference does not resolve. */
  dangling?: boolean;
}

function Field({label, children}: {label: string; children: React.ReactNode}): React.ReactElement {
  return (
    <Box>
      <Text dimColor>{label.padEnd(10)}</Text>
      {children}
    </Box>
  );
}

export function DetailScreen({
  file,
  nowIso,
  height,
  dangling = false,
}: DetailScreenProps): React.ReactElement {
  const task = file.task;
  const overdue = isOverdue(task, nowIso);

  const prose = task.body.trim();
  // Leave room for the fields above and the log below rather than letting a long body
  // push everything else off the screen.
  const proseBudget = Math.max(2, Math.floor((height - 10) / 2));
  const proseLines = prose.length > 0 ? prose.split('\n').slice(0, proseBudget) : [];
  const proseTruncated = prose.split('\n').length > proseLines.length;

  const logBudget = Math.max(2, height - 10 - proseLines.length);
  const log = task.log.slice(-logBudget);
  const logHidden = task.log.length - log.length;

  return (
    <Box flexDirection="column">
      <Text bold color="cyan">
        {task.title}
      </Text>
      <Box height={1} />

      <Field label="id">
        <Text>{task.id}</Text>
      </Field>
      <Field label="state">
        <Text>{task.state}</Text>
      </Field>
      <Field label="created">
        <Text>{task.created}</Text>
      </Field>
      {task.tags.length > 0 && (
        <Field label="tags">
          <Text color="blue">{task.tags.map(t => `#${t}`).join(' ')}</Text>
        </Field>
      )}
      {task.project !== undefined && (
        <Field label="project">
          <Text color={dangling ? 'yellow' : 'magenta'}>
            {task.project}
            {dangling ? '  (no such project)' : ''}
          </Text>
        </Field>
      )}
      {task.due !== undefined && (
        <Field label="due">
          <Text color={overdue ? 'red' : undefined}>
            {task.due}
            {overdue ? '  overdue' : ''}
          </Text>
        </Field>
      )}
      {task.defer !== undefined && (
        <Field label="defer">
          <Text>{task.defer}</Text>
        </Field>
      )}
      {task.waitingOn !== undefined && (
        <Field label="waiting">
          <Text color="yellow">{task.waitingOn}</Text>
        </Field>
      )}
      {task.done !== undefined && (
        <Field label="done">
          <Text>{task.done}</Text>
        </Field>
      )}

      {proseLines.length > 0 && (
        <>
          <Box height={1} />
          {proseLines.map((line, i) => (
            <Text key={i}>{line}</Text>
          ))}
          {proseTruncated && <Text dimColor>… press e to read it all in $EDITOR</Text>}
        </>
      )}

      <Box height={1} />
      {task.log.length === 0 ? (
        <Text dimColor>No log entries yet.</Text>
      ) : (
        <>
          <Text dimColor>Log{logHidden > 0 ? `  (${logHidden} earlier hidden)` : ''}</Text>
          {log.map((entry, i) => (
            <Box key={i}>
              <Text dimColor>{entry.parsed ? entry.at : ''} </Text>
              <Text color={entry.actor.startsWith('agent:') ? 'magenta' : undefined}>
                {entry.actor.length > 0 ? `${entry.actor} ` : ''}
              </Text>
              <Text>{entry.parsed ? entry.text : entry.raw.trim()}</Text>
            </Box>
          ))}
        </>
      )}

      <Box height={1} />
      <Text dimColor>{file.path}</Text>
    </Box>
  );
}
