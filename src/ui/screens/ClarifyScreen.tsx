/**
 * One question of the guided clarify flow.
 *
 * The screen holds nothing. Which question is showing, what has been answered, and what
 * the answers add up to all live in the reducer in `core/clarify.ts`, so this renders a
 * value and forwards a keypress — the same arrangement as the weekly walk.
 *
 * The item being clarified stays on screen above the question, because the whole point
 * of the ritual is answering about *this* thing rather than about the pile.
 *
 * The keys are not repeated here: the hint row at the bottom of the app already carries
 * them, and says different things for a question you choose an answer to and one you
 * type an answer into. Two places saying it is two places to get out of step.
 */
import React from 'react';
import {Box, Text} from 'ink';
import type {ClarifyQuestion} from '../../core/clarify.ts';
import type {TaskFile} from '../../core/types.ts';

export interface ClarifyScreenProps {
  file: TaskFile;
  question: ClarifyQuestion;
  /** How many items are still in the list behind this one. */
  remaining: number;
}

export function ClarifyScreen({file, question, remaining}: ClarifyScreenProps): React.ReactElement {
  return (
    <Box flexDirection="column">
      <Box>
        <Text dimColor>clarifying{'   '}</Text>
        <Text bold color="cyan">
          {file.task.title}
        </Text>
        {remaining > 0 && (
          <Text dimColor>
            {'   '}
            {remaining} more after this
          </Text>
        )}
      </Box>

      {file.task.body.trim().length > 0 && (
        <Box marginTop={1}>
          <Text dimColor>{file.task.body.trim().split('\n').slice(0, 3).join('\n')}</Text>
        </Box>
      )}

      <Box marginTop={1}>
        <Text bold>{question.prompt}</Text>
      </Box>
      {question.hint !== undefined && <Text dimColor>{question.hint}</Text>}

      {question.choices.length > 0 && (
        <Box flexDirection="column" marginTop={1}>
          {question.choices.map(choice => (
            <Box key={choice.key}>
              <Text color="cyan" bold>
                {'  '}
                {choice.key}
              </Text>
              <Text>
                {'  '}
                {choice.label}
              </Text>
            </Box>
          ))}
        </Box>
      )}
    </Box>
  );
}
