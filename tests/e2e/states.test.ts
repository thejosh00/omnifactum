/**
 * Every state the app has, reachable and named everywhere it should be.
 *
 * `review` was added to `TASK_STATES` and to the directory layout, and then four places
 * that spell the states out by hand were not updated: the state filter, the error text
 * in `add`, the usage line in `mv`, and the command table in AGENTS.md. Nothing failed —
 * `omni list -s review` simply printed the next actions instead, which is the worst
 * possible outcome for an agent following instructions correctly.
 *
 * So these tests iterate `TASK_STATES` rather than naming states, and the next state
 * added is covered the moment it exists.
 */
import {afterEach, describe, expect, test} from 'bun:test';
import {agentsDocument} from '../../src/core/agentsDoc.ts';
import {COMMAND_NAMES} from '../../src/cli.ts';
import {EXIT_OK, EXIT_USAGE} from '../../src/commands/context.ts';
import {LIST_STATES, TASK_STATES} from '../../src/core/types.ts';
import {makeVault, type Vault} from '../helpers/vault.ts';
import {omni} from '../helpers/cli.ts';

const NOW = '2026-09-12T11:03:00Z';

let vault: Vault | undefined;
const openVault = (): Vault => {
  vault = makeVault({layout: false});
  return vault;
};

afterEach(() => {
  vault?.cleanup();
  vault = undefined;
});

/** One task parked in each state, so a filter that returns the wrong list is visible. */
async function oneOfEach(): Promise<Vault> {
  const v = openVault();
  for (const state of TASK_STATES) {
    await omni(['add', `A task in ${state}`, '-s', state], {dir: v.dir, now: NOW});
  }
  return v;
}

describe('the state filter', () => {
  test('returns that state and no other, for every state there is', async () => {
    const v = await oneOfEach();

    for (const state of TASK_STATES) {
      const result = await omni(['list', '-s', state, '--json'], {dir: v.dir, now: NOW});
      const tasks = JSON.parse(result.stdout) as Array<{state: string; title: string}>;

      expect({state, code: result.code}).toEqual({state, code: EXIT_OK});
      expect({state, got: tasks.map(t => t.state)}).toEqual({state, got: [state]});
      expect({state, title: tasks[0]?.title}).toEqual({state, title: `A task in ${state}`});
    }
  });

  test('a state it does not know is refused, not quietly ignored', async () => {
    const v = await oneOfEach();
    const result = await omni(['list', '-s', 'nonsense'], {dir: v.dir, now: NOW});

    expect(result.code).toBe(EXIT_USAGE);
    // And the message says what the states actually are, all of them.
    for (const state of TASK_STATES) expect(result.stderr).toContain(state);
  });
});

describe('the per-state shorthands', () => {
  test('every state that has one is a real command', () => {
    for (const state of LIST_STATES) {
      expect({state, registered: COMMAND_NAMES.includes(state)}).toEqual({state, registered: true});
    }
  });

  test('each shows only its own state', async () => {
    const v = await oneOfEach();

    for (const state of LIST_STATES) {
      const result = await omni([state, '--json'], {dir: v.dir, now: NOW});
      const tasks = JSON.parse(result.stdout) as Array<{state: string}>;
      expect({state, got: tasks.map(t => t.state)}).toEqual({state, got: [state]});
    }
  });
});

describe('what the app tells you the states are', () => {
  test('the error from add names every one', async () => {
    const v = openVault();

    const result = await omni(['add', 'Something', '-s', 'nonsense'], {dir: v.dir, now: NOW});
    expect(result.code).toBe(EXIT_USAGE);
    for (const state of TASK_STATES) expect(result.stderr).toContain(state);
  });

  test('the usage line from mv names every one', async () => {
    const v = openVault();

    const result = await omni(['mv', 'whatever'], {dir: v.dir, now: NOW});
    expect(result.code).toBe(EXIT_USAGE);
    for (const state of TASK_STATES) expect(result.stderr).toContain(state);
  });

  test('the agent contract names every one in its command table', () => {
    const doc = agentsDocument();
    const table = doc.slice(doc.indexOf('## The commands'), doc.indexOf('## Exit codes'));

    for (const state of TASK_STATES) {
      expect({state, inTable: table.includes(state)}).toEqual({state, inTable: true});
    }
  });

  test('and every shorthand it cites is one that exists', () => {
    const doc = agentsDocument();
    for (const state of LIST_STATES) {
      expect({state, cited: doc.includes(`\`${state}\``)}).toEqual({state, cited: true});
    }
  });
});
