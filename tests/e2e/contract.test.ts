/**
 * Does AGENTS.md still tell the truth?
 *
 * The document is the agent interface. If it says one thing and the code does another,
 * agents will do the wrong thing confidently while following instructions correctly,
 * which makes drift the highest-consequence bug this project can have.
 *
 * These tests do not read the document for style. They pull the commands, the JSON
 * shapes and the exit codes out of it and check them against what the app actually
 * does.
 */
import {afterEach, describe, expect, test} from 'bun:test';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {agentsDocument} from '../../src/core/agentsDoc.ts';
import {COMMAND_ALIASES, COMMAND_NAMES} from '../../src/cli.ts';
import {
  EXIT_BUSY,
  EXIT_ERROR,
  EXIT_NOT_FOUND,
  EXIT_OK,
  EXIT_USAGE,
} from '../../src/commands/context.ts';
import {isValidTag} from '../../src/core/tags.ts';
import {readTask} from '../../src/core/task.ts';
import {baseDirectories} from '../../src/core/state.ts';
import {makeVault, type Vault} from '../helpers/vault.ts';
import {omni} from '../helpers/cli.ts';

const NOW = '2026-09-12T11:03:00Z';
const DOC = agentsDocument();

let vault: Vault | undefined;
const openVault = (): Vault => {
  vault = makeVault({layout: false});
  return vault;
};

afterEach(() => {
  vault?.cleanup();
  vault = undefined;
});

function codeBlocks(language: string): string[] {
  const blocks: string[] = [];
  const pattern = new RegExp('```' + language + '\\n([\\s\\S]*?)```', 'g');
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(DOC)) !== null) blocks.push(match[1]!);
  return blocks;
}

/** Every `omni <something>` the document tells an agent to run. */
function citedCommands(): string[] {
  return [...DOC.matchAll(/\bomni\s+([a-z-]+)/g)].map(m => m[1]!);
}

describe('the commands it cites', () => {
  test('all of them exist', () => {
    const known = new Set([...COMMAND_NAMES, ...Object.keys(COMMAND_ALIASES), 'help']);
    const cited = [...new Set(citedCommands())];
    expect(cited.length).toBeGreaterThan(8);
    for (const name of cited) {
      expect({command: name, known: known.has(name)}).toEqual({command: name, known: true});
    }
  });

  test('the ones in the command table run without erroring', async () => {
    const v = openVault();
    await omni(['init'], {dir: v.dir, now: NOW});
    await omni(['add', 'Something', '-t', 'agent', '--next'], {dir: v.dir, now: NOW});

    for (const args of [['list'], ['inbox'], ['next'], ['waiting'], ['someday'], ['tags'], ['due'], ['doctor']]) {
      const result = await omni([...args, '--json'], {dir: v.dir, now: NOW});
      expect({args, code: result.code}).toEqual({args, code: 0});
      expect(() => JSON.parse(result.stdout)).not.toThrow();
    }
  });
});

describe('the exit codes it documents', () => {
  test('match the ones the app uses', () => {
    const table = [...DOC.matchAll(/^\| (\d) \| (.+?) \|$/gm)].map(m => Number(m[1]));
    expect(table).toEqual([EXIT_OK, EXIT_ERROR, EXIT_USAGE, EXIT_NOT_FOUND, EXIT_BUSY]);
  });

  test('an unknown task really does exit 3, as claimed', async () => {
    const v = openVault();
    await omni(['init'], {dir: v.dir, now: NOW});
    expect((await omni(['show', 'nope', '--json'], {dir: v.dir, now: NOW})).code).toBe(EXIT_NOT_FOUND);
  });

  test('a bad command really does exit 2, as claimed', async () => {
    const v = openVault();
    await omni(['init'], {dir: v.dir, now: NOW});
    expect((await omni(['mv', 'x', 'nowhere', '--json'], {dir: v.dir, now: NOW})).code).toBe(EXIT_USAGE);
  });
});

describe('the JSON it shows', () => {
  test('a listed task really has every field the example shows', async () => {
    const v = openVault();
    await omni(['init'], {dir: v.dir, now: NOW});
    await omni(['add', 'Fix printer driver', '-t', 'home,agent', '--next'], {dir: v.dir, now: NOW});

    const example = codeBlocks('json').find(block => block.trimStart().startsWith('['));
    expect(example).toBeDefined();
    const [shape] = JSON.parse(example!) as Array<Record<string, unknown>>;

    const real = (
      JSON.parse((await omni(['next', '--tag', 'agent', '--json'], {dir: v.dir, now: NOW})).stdout) as Array<
        Record<string, unknown>
      >
    )[0]!;

    for (const key of Object.keys(shape!)) {
      expect({key, present: key in real}).toEqual({key, present: true});
    }
  });

  test('a completion really returns the envelope the example shows', async () => {
    const v = openVault();
    await omni(['init'], {dir: v.dir, now: NOW});
    await omni(['add', 'Fix printer driver', '--next'], {dir: v.dir, now: NOW});

    const example = codeBlocks('json').find(block => block.includes('"ok": true'));
    expect(example).toBeDefined();
    const shape = JSON.parse(example!) as {ok: boolean; task: Record<string, unknown>};

    const real = JSON.parse(
      (await omni(['done', 'fix-printer-driver', '--note', 'Did it', '--json'], {dir: v.dir, now: NOW}))
        .stdout,
    ) as {ok: boolean; task: Record<string, unknown>};

    expect(real.ok).toBe(true);
    for (const key of Object.keys(shape.task)) {
      expect({key, present: key in real.task}).toEqual({key, present: true});
    }
    expect(real.task['state']).toBe('done');
  });

  test('a failure really is an envelope on stdout with stderr empty, as claimed', async () => {
    const v = openVault();
    await omni(['init'], {dir: v.dir, now: NOW});

    const example = codeBlocks('json').find(block => block.includes('"ok": false'));
    expect(example).toBeDefined();
    const shape = JSON.parse(example!) as Record<string, unknown>;

    const result = await omni(['done', 'nope', '--json'], {dir: v.dir, now: NOW});
    const real = JSON.parse(result.stdout) as Record<string, unknown>;

    expect(result.stderr).toBe('');
    for (const key of Object.keys(shape)) {
      expect({key, present: key in real}).toEqual({key, present: true});
    }
  });
});

describe('the procedures it gives', () => {
  test('finding tagged work returns only the tagged work', async () => {
    const v = openVault();
    await omni(['init'], {dir: v.dir, now: NOW});
    await omni(['add', 'For the agent', '-t', 'agent', '--next'], {dir: v.dir, now: NOW});
    await omni(['add', 'For me', '-t', 'personal', '--next'], {dir: v.dir, now: NOW});

    const tasks = JSON.parse(
      (await omni(['next', '--tag', 'agent', '--json'], {dir: v.dir, now: NOW})).stdout,
    ) as Array<{title: string}>;

    expect(tasks.map(t => t.title)).toEqual(['For the agent']);
  });

  test('all three ways of referring to a task work, as claimed', async () => {
    const v = openVault();
    await omni(['init'], {dir: v.dir, now: NOW});
    await omni(['add', 'Fix printer driver', '--next'], {dir: v.dir, now: NOW});

    const id = (
      JSON.parse((await omni(['next', '--json'], {dir: v.dir, now: NOW})).stdout) as Array<{id: string}>
    )[0]!.id;

    for (const ref of [id, id.slice(0, 5), 'fix-printer-driver']) {
      expect((await omni(['show', ref, '--json'], {dir: v.dir, now: NOW})).code).toBe(0);
    }
  });

  test('reporting a blocked task the way it suggests works', async () => {
    const v = openVault();
    await omni(['init'], {dir: v.dir, now: NOW});
    await omni(['add', 'Blocked thing', '-t', 'agent', '--next'], {dir: v.dir, now: NOW});

    expect((await omni(['mv', 'blocked-thing', 'waiting', '--json'], {dir: v.dir, now: NOW})).code).toBe(0);
    expect((await omni(['tag', 'blocked-thing', '+needs-review', '--json'], {dir: v.dir, now: NOW})).code).toBe(0);
    expect(v.read('waiting/blocked-thing.md')).toContain('needs-review');
  });

  test('a deferred task is invisible to the agent list, as claimed', async () => {
    const v = openVault();
    await omni(['init'], {dir: v.dir, now: NOW});
    await omni(['add', 'Not yet', '-t', 'agent', '-s', 'someday', '--defer', '2027-01-01'], {
      dir: v.dir,
      now: NOW,
    });

    const tasks = JSON.parse(
      (await omni(['next', '--tag', 'agent', '--json'], {dir: v.dir, now: NOW})).stdout,
    ) as unknown[];
    expect(tasks).toEqual([]);
  });

  test('a project really carries the stalled flag it describes', async () => {
    const v = openVault();
    await omni(['init'], {dir: v.dir, now: NOW});
    await omni(['project', 'new', 'Kitchen', '--outcome', 'Finished'], {dir: v.dir, now: NOW});

    const [project] = JSON.parse(
      (await omni(['project', 'list', '--json'], {dir: v.dir, now: NOW})).stdout,
    ) as Array<Record<string, unknown>>;
    expect(project!['stalled']).toBe(true);
  });

  test('rm really does require --yes, as claimed', async () => {
    const v = openVault();
    await omni(['init'], {dir: v.dir, now: NOW});
    await omni(['add', 'Precious'], {dir: v.dir, now: NOW});

    expect((await omni(['rm', 'precious', '--json'], {dir: v.dir, now: NOW})).code).not.toBe(0);
    expect(v.list()).toHaveLength(1);
  });
});

describe('the review rule it states', () => {
  test('the submit procedure it documents actually works', async () => {
    const v = openVault();
    await omni(['init'], {dir: v.dir, now: NOW});
    await omni(['add', 'Fix printer driver', '-t', 'agent', '--next'], {dir: v.dir, now: NOW});

    const result = await omni(
      ['submit', 'fix-printer-driver', '--note', 'Installed PPD 4.2.', '--actor', 'agent:test', '--json'],
      {dir: v.dir, now: NOW},
    );
    expect(result.code).toBe(0);
    expect((JSON.parse(result.stdout) as {task: {state: string}}).task.state).toBe('review');
  });

  test('done really is refused for agents, exactly as it claims', () => {
    expect(DOC).toContain('`omni done` is refused for agents');
  });

  test('and the refusal is real, not just documented', async () => {
    const v = openVault();
    await omni(['init'], {dir: v.dir, now: NOW});
    await omni(['add', 'Fix printer driver', '--next'], {dir: v.dir, now: NOW});

    const refused = await omni(
      ['done', 'fix-printer-driver', '--actor', 'agent:test', '--json'],
      {dir: v.dir, now: NOW},
    );
    expect(refused.code).not.toBe(0);
    expect((JSON.parse(refused.stdout) as {ok: boolean}).ok).toBe(false);
  });

  test('the note it says is required really is required', async () => {
    const v = openVault();
    await omni(['init'], {dir: v.dir, now: NOW});
    await omni(['add', 'Fix printer driver', '--next'], {dir: v.dir, now: NOW});

    expect(DOC).toContain('`--note` is required');
    const result = await omni(['submit', 'fix-printer-driver', '--actor', 'agent:test', '--json'], {
      dir: v.dir,
      now: NOW,
    });
    expect(result.code).not.toBe(0);
  });

  test('the rejection path it describes carries a reason', async () => {
    const v = openVault();
    await omni(['init'], {dir: v.dir, now: NOW});
    await omni(['add', 'Fix printer driver', '--next'], {dir: v.dir, now: NOW});
    await omni(['submit', 'fix-printer-driver', '--note', 'did it', '--actor', 'agent:test'], {
      dir: v.dir,
      now: NOW,
    });

    const sentBack = await omni(
      ['mv', 'fix-printer-driver', 'next', '--note', 'still jams', '--json'],
      {dir: v.dir, now: NOW},
    );
    expect(sentBack.code).toBe(0);
    expect(v.read('next/fix-printer-driver.md')).toContain('still jams');
  });
});

describe('the raw format it describes as a fallback', () => {
  test('the example task file parses with no repairs needed', () => {
    const example = codeBlocks('markdown')[0];
    expect(example).toBeDefined();

    const result = readTask(example!, {
      state: 'next',
      stem: 'fix-printer-driver',
      birthtimeMs: Date.UTC(2026, 8, 12),
      mtimeMs: Date.UTC(2026, 8, 12),
      nowIso: NOW,
      mintId: () => 'zzzzzzzzzzzz',
    });

    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    expect(result.needsHealing).toBe(false);
    expect(result.task.tags).toEqual(['home', 'errand', 'agent']);
  });

  test('it names every state directory the app creates', () => {
    for (const dir of ['inbox/', 'next/', 'waiting/', 'someday/', 'done/YYYY-MM/']) {
      expect(DOC).toContain(dir);
    }
    expect(baseDirectories()).toContain('projects/active');
  });

  test('the tag rule it quotes accepts what it tells agents to write', () => {
    for (const tag of ['home', 'errand', 'agent', 'needs-review', 'calls']) {
      expect(isValidTag(tag)).toBe(true);
    }
    expect(DOC).toContain('lowercase, no spaces');
  });
});

describe('the document as the app ships it', () => {
  test('omni init writes it, and omni agents prints what is on disk', async () => {
    const v = openVault();
    await omni(['init'], {dir: v.dir, now: NOW});

    expect(readFileSync(join(v.dir, 'AGENTS.md'), 'utf8')).toBe(DOC);
    expect((await omni(['agents'], {dir: v.dir, now: NOW})).stdout).toBe(DOC.trimEnd());
  });

  test('it tells agents to use the CLI rather than write files', () => {
    expect(DOC).toContain('Do not write the files directly');
    expect(DOC).toContain('--json');
  });

  test('a hand-edited document is preserved rather than silently replaced', async () => {
    const v = openVault();
    await omni(['init'], {dir: v.dir, now: NOW});
    v.put('AGENTS.md', '# my own notes\n');

    const result = await omni(['init'], {dir: v.dir, now: NOW});
    expect(result.stderr).toContain('AGENTS.local.md');
    expect(v.read('AGENTS.md.previous')).toBe('# my own notes\n');
  });
});
