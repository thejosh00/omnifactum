/**
 * The header for one step of the weekly review.
 *
 * The walk deliberately reuses the ordinary list underneath: a weekly review is a tour
 * of lists you already have, with a different question asked of each. That is why it
 * needed no new way to change a task — every key that works on a list works here, so
 * you can act on what you find without leaving the walk.
 */
import React from 'react';
import {Box, Text} from 'ink';
import type {ReviewStep} from '../../core/review.ts';

export interface WeeklyScreenProps {
  step: ReviewStep;
  index: number;
  total: number;
  /** True on the last step, where advancing records the pass. */
  last: boolean;
}

export function WeeklyHeader({step, index, total, last}: WeeklyScreenProps): React.ReactElement {
  const clear = step.flags.length === 0;

  return (
    <Box flexDirection="column">
      <Box>
        <Text dimColor>
          weekly review {index + 1}/{total}
          {'   '}
        </Text>
        <Text bold color="cyan">
          {step.title}
        </Text>
        <Text dimColor>
          {'   '}
          {step.count} item{step.count === 1 ? '' : 's'}
        </Text>
        {clear && <Text color="green">   clear</Text>}
      </Box>

      <Text dimColor>{step.prompt}</Text>

      {step.flags.length > 0 && (
        <Box flexDirection="column" marginTop={1}>
          {step.flags.slice(0, 4).map((flag, i) => (
            <Text key={i} color="yellow">
              · {flag}
            </Text>
          ))}
          {step.flags.length > 4 && (
            <Text dimColor>  …and {step.flags.length - 4} more</Text>
          )}
        </Box>
      )}

      <Box marginTop={1}>
        <Text dimColor>
          {last ? 'n finishes and records this pass' : 'n next step   b back   esc leave'}
        </Text>
      </Box>
    </Box>
  );
}
