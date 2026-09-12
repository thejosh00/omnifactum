/**
 * The help screen, rendered from the keymap table itself.
 *
 * Nothing here is written by hand, so a key that exists is documented and a key that is
 * documented exists.
 */
import React from 'react';
import {Box, Text} from 'ink';
import {BINDINGS, GROUP_TITLES} from '../keymap.ts';
import type {Binding} from '../keymap.ts';

export function HelpScreen(): React.ReactElement {
  const groups = new Map<Binding['group'], Binding[]>();
  for (const binding of BINDINGS) {
    const existing = groups.get(binding.group);
    if (existing === undefined) groups.set(binding.group, [binding]);
    else existing.push(binding);
  }

  const keyWidth = Math.max(...BINDINGS.map(b => b.keys.length));

  return (
    <Box flexDirection="column">
      <Text bold color="cyan">
        Keys
      </Text>
      <Box height={1} />

      {[...groups.entries()].map(([group, bindings]) => (
        <Box key={group} flexDirection="column">
          <Text dimColor>{GROUP_TITLES[group]}</Text>
          {bindings.map(binding => (
            <Box key={binding.intent}>
              <Text>  </Text>
              <Text bold>{binding.keys.padEnd(keyWidth)}</Text>
              <Text>  {binding.label}</Text>
            </Box>
          ))}
          <Box height={1} />
        </Box>
      ))}

      <Text dimColor>Filtering uses the same query as the command line:</Text>
      <Text dimColor>  home errand    both tags</Text>
      <Text dimColor>  home,errand    either tag</Text>
      <Text dimColor>  -someday       exclude</Text>
      <Text dimColor>  /printer       search the text</Text>
      <Text dimColor>  project:kitchen, due:today, is:overdue</Text>
      <Box height={1} />
      <Text dimColor>Press any key to go back.</Text>
    </Box>
  );
}
