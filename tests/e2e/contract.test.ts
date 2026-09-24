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
import {agentsDocument} from '../../src/core/agentsDoc.ts';
import {COMMAND_ALIASES, COMMAND_NAMES, LOCAL_COMMAND_NAMES} from '../../src/cli.ts';
import {
  EXIT_BUSY,
  EXIT_ERROR,
  EXIT_NOT_FOUND,
  EXIT_OK,
  EXIT_USAGE,
} from '../../src/commands/context.ts';
import {isValidTag} from '../../src/core/tags.ts';
import {makeVault, type Vault} from '../helpers/vault.ts';
import {omni, serveFor} from '../helpers/cli.ts';

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
    const known = new Set([...COMMAND_NAMES, ...Object.keys(COMMAND_ALIASES), ...LOCAL_COMMAND_NAMES, 'help']);
    const cited = [...new Set(citedCommands())];
    expect(cited.length).toBeGreaterThan(8);
    for (const name of cited) {
      expect({command: name, known: known.has(name)}).toEqual({command: name, known: true});
    }
  });

  test('the ones in the command table run without erroring', async () => {
    const v = openVault();
    await omni(['add', 'Something', '-t', 'agent', '--next'], {dir: v.dir, now: NOW});

    for (const args of [['list'], ['inbox'], ['next'], ['waiting'], ['someday'], ['review'], ['tags'], ['due'], ['project', 'list']]) {
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
    expect((await omni(['show', 'nope', '--json'], {dir: v.dir, now: NOW})).code).toBe(EXIT_NOT_FOUND);
  });

  test('a bad command really does exit 2, as claimed', async () => {
    const v = openVault();
    expect((await omni(['mv', 'x', 'nowhere', '--json'], {dir: v.dir, now: NOW})).code).toBe(EXIT_USAGE);
  });
});

describe('the JSON it shows', () => {
  test('a listed task really has every field the example shows', async () => {
    const v = openVault();
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
    await omni(['add', 'For the agent', '-t', 'agent', '--next'], {dir: v.dir, now: NOW});
    await omni(['add', 'For me', '-t', 'personal', '--next'], {dir: v.dir, now: NOW});

    const tasks = JSON.parse(
      (await omni(['next', '--tag', 'agent', '--json'], {dir: v.dir, now: NOW})).stdout,
    ) as Array<{title: string}>;

    expect(tasks.map(t => t.title)).toEqual(['For the agent']);
  });

  test('all three ways of referring to a task work, as claimed', async () => {
    const v = openVault();
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
    await omni(['add', 'Blocked thing', '-t', 'agent', '--next'], {dir: v.dir, now: NOW});

    expect((await omni(['mv', 'blocked-thing', 'waiting', '--json'], {dir: v.dir, now: NOW})).code).toBe(0);
    expect((await omni(['tag', 'blocked-thing', '+needs-review', '--json'], {dir: v.dir, now: NOW})).code).toBe(0);
    expect(v.read('waiting/blocked-thing.md')).toContain('needs-review');
  });

  test('a deferred task is invisible to the agent list, as claimed', async () => {
    const v = openVault();
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
    await omni(['project', 'new', 'Kitchen', '--outcome', 'Finished'], {dir: v.dir, now: NOW});

    const [project] = JSON.parse(
      (await omni(['project', 'list', '--json'], {dir: v.dir, now: NOW})).stdout,
    ) as Array<Record<string, unknown>>;
    expect(project!['stalled']).toBe(true);
  });

  test('rm really does require --yes, as claimed', async () => {
    const v = openVault();
    await omni(['add', 'Precious'], {dir: v.dir, now: NOW});

    expect((await omni(['rm', 'precious', '--json'], {dir: v.dir, now: NOW})).code).not.toBe(0);
    expect(v.list()).toHaveLength(1);
  });
});

describe('the review rule it states', () => {
  test('the submit procedure it documents actually works', async () => {
    const v = openVault();
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

describe('the HTTP API it documents', () => {
  /** The rows of the HTTP table: method, path. */
  function documentedRoutes(): Array<[string, string]> {
    return [...DOC.matchAll(/^\| `(GET|POST|PATCH|DELETE) (\/api\/[^`]+)`/gm)].map(m => [m[1]!, m[2]!]);
  }

  test('every row it lists answers, rather than 404ing', async () => {
    const v = openVault();
    const server = serveFor(v.dir, NOW);
    try {
      const token = server.token('agent:contract');
      await omni(['add', 'Fix printer driver', '-t', 'agent', '--next'], {dir: v.dir, now: NOW});

      const routes = documentedRoutes();
      expect(routes.length).toBeGreaterThan(8);

      const bodies: Record<string, unknown> = {
        '/api/tasks': {title: 'From HTTP', state: 'next', tags: ['agent']},
        submit: {note: 'did it'},
        note: {note: 'progress'},
        move: {to: 'someday', note: 'not now'},
        tags: {add: ['http']},
      };

      for (const [method, template] of routes) {
        const path = template.split('?')[0]!.replace('<task>', 'fix-printer-driver');
        const query = template.includes('?') ? `?${template.split('?')[1]}` : '';
        const action = path.split('/').at(-1)!;
        const body = method === 'GET' ? undefined : (bodies[path] ?? bodies[action] ?? {title: 'Renamed'});

        // Each write starts from a task in next, so the order of rows does not matter.
        if (method !== 'GET') await omni(['mv', 'fix-printer-driver', 'next'], {dir: v.dir, now: NOW});
        const current = JSON.parse((await omni(['show', 'fix-printer-driver', '--json'], {dir: v.dir, now: NOW})).stdout) as {
          version: number;
        };

        const response = await fetch(`${server.url}${path}${query}`, {
          method,
          headers: {
            authorization: `Bearer ${token}`,
            'content-type': 'application/json',
            ...(method === 'PATCH' ? {'if-match': String(current.version)} : {}),
          },
          ...(body === undefined ? {} : {body: JSON.stringify(body)}),
        });
        const json = (await response.json()) as {ok?: boolean};
        expect({method, path, success: response.ok && json.ok === true}).toEqual({method, path, success: true});
      }
    } finally {
      await server.stop();
    }
  });

  test('a stale PATCH really is refused with 409 and the current task, as it says', async () => {
    const v = openVault();
    const server = serveFor(v.dir, NOW);
    try {
      const token = server.token('agent:contract');
      await omni(['add', 'Fix printer driver', '--next'], {dir: v.dir, now: NOW});
      await omni(['note', 'fix-printer-driver', 'moved on'], {dir: v.dir, now: NOW});

      const response = await fetch(`${server.url}/api/tasks/fix-printer-driver`, {
        method: 'PATCH',
        headers: {authorization: `Bearer ${token}`, 'if-match': '1'},
        body: JSON.stringify({title: 'Mine'}),
      });
      expect(response.status).toBe(409);
      expect(((await response.json()) as {task: {version: number}}).task.version).toBe(2);
    } finally {
      await server.stop();
    }
  });
});

describe('the document as the app ships it', () => {
  test('omni agents prints it, and the server serves the same text', async () => {
    const v = openVault();
    expect((await omni(['agents'], {dir: v.dir, now: NOW})).stdout).toBe(DOC.trimEnd());

    const server = serveFor(v.dir, NOW);
    try {
      const response = await fetch(`${server.url}/api/agents`, {
        headers: {authorization: `Bearer ${server.token('agent:reader')}`},
      });
      expect(((await response.json()) as {contract: string}).contract).toBe(DOC);
    } finally {
      await server.stop();
    }
  });

  test('it tells agents to go through omni rather than the database', () => {
    expect(DOC).toContain('Do not write to the database directly');
    expect(DOC).toContain('--json');
  });

  test('the tag rule it quotes accepts what it tells agents to write', () => {
    for (const tag of ['home', 'errand', 'agent', 'needs-review', 'calls']) {
      expect(isValidTag(tag)).toBe(true);
    }
    expect(DOC).toContain('lowercase, no spaces');
  });

  test('it tells agents how to get connected before anything else', () => {
    expect(DOC.indexOf('OMNI_TOKEN')).toBeLessThan(DOC.indexOf('## Finding work'));
    expect(DOC).toContain('omni account token');
  });
});
