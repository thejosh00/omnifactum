/**
 * A one-line text input.
 *
 * Hand-rolled rather than pulled from a package: it is forty lines, it needs to behave
 * exactly the same under the test harness as in a real terminal, and the one obvious
 * dependency declares a loose peer range against an older Ink.
 *
 * It owns no state. The value lives in the view above it, which is what lets a keypress
 * be tested without rendering.
 */
import React from 'react';
import {Box, Text, useInput} from 'ink';

export interface TextInputProps {
  value: string;
  placeholder?: string;
  /** Rendered before the value, e.g. a `/` for the filter bar. */
  prompt?: string;
  onChange: (value: string) => void;
  onSubmit: (value: string) => void;
  onCancel: () => void;
  /** Offered on tab. */
  completions?: string[];
  focus?: boolean;
}

export function TextInput({
  value,
  placeholder,
  prompt,
  onChange,
  onSubmit,
  onCancel,
  completions = [],
  focus = true,
}: TextInputProps): React.ReactElement {
  useInput(
    (input, key) => {
      if (key.escape) {
        onCancel();
        return;
      }
      if (key.return) {
        onSubmit(value);
        return;
      }
      if (key.backspace || key.delete) {
        onChange(value.slice(0, -1));
        return;
      }
      if (key.tab) {
        const completion = completeLastWord(value, completions);
        if (completion !== undefined) onChange(completion);
        return;
      }
      if (key.ctrl) {
        // The field is pre-filled when editing something that already exists, so
        // there has to be a way to start over that is not thirty backspaces.
        if (input === 'u') onChange('');
        else if (input === 'w') onChange(deleteLastWord(value));
        return;
      }
      // Only printable text edits the value.
      if (key.meta || input.length === 0) return;
      onChange(value + input);
    },
    {isActive: focus},
  );

  const showPlaceholder = value.length === 0 && placeholder !== undefined;

  return (
    <Box>
      {prompt !== undefined && <Text color="cyan">{prompt}</Text>}
      <Text dimColor={showPlaceholder}>{showPlaceholder ? placeholder : value}</Text>
      <Text inverse> </Text>
    </Box>
  );
}

/** Drop the last word, and any spaces before it. */
export function deleteLastWord(value: string): string {
  return value.replace(/\s*\S*$/, '');
}

/** Complete the word under the cursor from the offered list, longest common prefix. */
export function completeLastWord(value: string, completions: readonly string[]): string | undefined {
  const match = /(^|\s)(\S*)$/.exec(value);
  if (match === null) return undefined;

  const partial = match[2] ?? '';
  const head = value.slice(0, value.length - partial.length);

  const candidates = completions.filter(option => option.startsWith(partial));
  if (candidates.length === 0) return undefined;
  if (candidates.length === 1) return `${head}${candidates[0]!} `;

  const shared = commonPrefix(candidates);
  return shared.length > partial.length ? `${head}${shared}` : undefined;
}

function commonPrefix(values: readonly string[]): string {
  if (values.length === 0) return '';
  let prefix = values[0]!;
  for (const value of values.slice(1)) {
    let i = 0;
    while (i < prefix.length && i < value.length && prefix[i] === value[i]) i++;
    prefix = prefix.slice(0, i);
  }
  return prefix;
}
