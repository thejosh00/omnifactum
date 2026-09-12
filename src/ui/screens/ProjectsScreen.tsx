/**
 * The project list, with the stalled ones called out.
 *
 * A stalled project is an active project with nothing in `next/` or `waiting/`. It is
 * supposed to be moving and nothing can move it, which is the one thing a first-class
 * project can tell you that a tag never could.
 */
import React from 'react';
import {Box, Text} from 'ink';
import {windowRange} from '../../core/view.ts';
import type {ProjectMembership} from '../../core/stalled.ts';

export interface ProjectsScreenProps {
  entries: ProjectMembership[];
  selectedIndex: number;
  height: number;
  orphanCount: number;
}

export function ProjectsScreen({
  entries,
  selectedIndex,
  height,
  orphanCount,
}: ProjectsScreenProps): React.ReactElement {
  if (entries.length === 0) {
    return (
      <Box flexDirection="column">
        <Text dimColor>No projects yet.</Text>
        <Box height={1} />
        <Text dimColor>A project is an outcome that needs more than one action.</Text>
        <Text dimColor>Create one with: omni project new "Title" --outcome "..."</Text>
      </Box>
    );
  }

  const rows = Math.max(1, height - (orphanCount > 0 ? 2 : 0));
  const {start, end} = windowRange(entries.length, selectedIndex, rows);
  const visible = entries.slice(start, end);
  const width = Math.max(...entries.map(e => e.project.stem.length));

  return (
    <Box flexDirection="column">
      {visible.map((entry, index) => {
        const selected = start + index === selectedIndex;
        const project = entry.project.project;
        const noOutcome = project.outcome.trim().length === 0;

        return (
          <Box key={entry.project.path}>
            <Text color={selected ? 'cyan' : undefined}>{selected ? '❯ ' : '  '}</Text>
            <Text bold={selected} color={selected ? 'cyan' : undefined}>
              {entry.project.stem.padEnd(width)}
            </Text>
            <Text>  </Text>
            {entry.stalled ? (
              <Text color="yellow">stalled </Text>
            ) : (
              <Text dimColor>{entry.live.length} live </Text>
            )}
            {entry.done.length > 0 && <Text dimColor>{entry.done.length} done </Text>}
            {project.state !== 'active' && <Text dimColor>{project.state} </Text>}
            {noOutcome && <Text color="yellow">no outcome </Text>}
            <Text dimColor>{project.title}</Text>
          </Box>
        );
      })}

      {orphanCount > 0 && (
        <>
          <Box height={1} />
          <Text color="yellow">
            {orphanCount} task{orphanCount === 1 ? '' : 's'} point at a project that does not exist.
            Run omni doctor.
          </Text>
        </>
      )}
    </Box>
  );
}
