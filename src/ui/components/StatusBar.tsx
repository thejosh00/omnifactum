/**
 * The lines that frame the list: what is being shown, what just happened, and what you
 * can press.
 */
import React from 'react';
import {Box, Text} from 'ink';
import {LISTS} from '../../core/view.ts';
import type {ListName} from '../../core/view.ts';
import type {TaskState} from '../../core/types.ts';

export interface StatusBarProps {
  list: ListName;
  counts: Record<TaskState, number>;
  shown: number;
  query: string;
  showDeferred: boolean;
  watching: boolean;
}

export function StatusBar({
  list,
  counts,
  shown,
  query,
  showDeferred,
  watching,
}: StatusBarProps): React.ReactElement {
  return (
    <Box>
      {LISTS.map((name, index) => {
        const active = name === list;
        return (
          <Text key={name}>
            {/*
              Two numbers sit either side of every name — the key that selects the list,
              and how many tasks are in it — so `1inbox 1` used to read as one blurred
              token. A space now separates each of them from the name.
              Only the leading key is dimmed: it is chrome, a shortcut you learn once.
              The count is the thing you are actually reading off this row, so it stays
              at full weight alongside the name.
            */}
            <Text dimColor>{index + 1} </Text>
            <Text color={active ? 'cyan' : undefined} bold={active}>
              {name}
            </Text>
            <Text> {counts[name]}</Text>
            {index < LISTS.length - 1 ? '  ' : ''}
          </Text>
        );
      })}
      <Box flexGrow={1} />
      {/* Written the way you would type it, which is also shorter than spelling it out. */}
      {query.trim().length > 0 && <Text color="cyan">/{query.trim()} </Text>}
      {showDeferred && <Text dimColor>+deferred </Text>}
      <Text dimColor>{shown} shown</Text>
      {/* Say so when live updates are off, rather than leaving the screen silently stale. */}
      {!watching && <Text dimColor> · not watching, press r</Text>}
    </Box>
  );
}

/**
 * A hairline between regions.
 *
 * One rule under the status bar is enough to stop the chrome and the content running
 * together. A second one above the hints would cost another row, and rows are the
 * scarcest thing on a terminal.
 */
export function Rule({width}: {width: number}): React.ReactElement {
  return <Text dimColor>{'─'.repeat(Math.max(1, width))}</Text>;
}

export type BannerTone = 'info' | 'warn' | 'error';

export interface BannerProps {
  message?: string | undefined;
  tone?: BannerTone;
}

export function Banner({message, tone = 'info'}: BannerProps): React.ReactElement {
  if (message === undefined || message.length === 0) return <Text> </Text>;

  const colour = tone === 'error' ? 'red' : tone === 'warn' ? 'yellow' : 'green';
  // A leading mark means the banner reads as a message rather than as another row of
  // content, even where colour is unavailable.
  const mark = tone === 'error' ? '✗' : tone === 'warn' ? '!' : '✓';

  return (
    <Text color={colour}>
      {mark} {message}
    </Text>
  );
}

export interface HintProps {
  hints: Array<[string, string]>;
  /**
   * The id of the row under the cursor. It lives down here rather than on every row,
   * because it is only wanted when copying a reference into a shell command — and here
   * rather than in the status bar, which is already the width-pressured line.
   */
  selectedId?: string | undefined;
}

export function Hints({hints, selectedId}: HintProps): React.ReactElement {
  return (
    <Box>
      {hints.map(([key, label], index) => (
        <Text key={key} dimColor>
          {index > 0 ? ' · ' : ''}
          <Text bold>{key}</Text> {label}
        </Text>
      ))}
      <Box flexGrow={1} />
      {selectedId !== undefined && <Text dimColor>{selectedId}</Text>}
    </Box>
  );
}

/** Shown where a list has nothing in it, with a nudge rather than just a full stop. */
export function EmptyState({
  message,
  hint,
}: {
  message: string;
  hint?: string;
}): React.ReactElement {
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text dimColor>  {message}</Text>
      {hint !== undefined && <Text dimColor>  {hint}</Text>}
    </Box>
  );
}
