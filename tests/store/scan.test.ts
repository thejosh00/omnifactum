import {afterEach, describe, expect, test} from 'bun:test';
import {mkdirSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {scanTasks} from '../../src/store/scan.ts';
import {backupConflict, TEMP_PREFIX} from '../../src/store/write.ts';
import {makeVault, taskFile, type Vault} from '../helpers/vault.ts';

let vault: Vault | undefined;
const openVault = (): Vault => {
  vault = makeVault();
  return vault;
};

afterEach(() => {
  vault?.cleanup();
  vault = undefined;
});

const scan = (dir: string) => scanTasks(dir, {mint: () => 'zzzzzzzzzzzz'});

describe('finding tasks', () => {
  test('reads a task from every state directory', () => {
    const v = openVault();
    v.put('inbox/a.md', taskFile({id: '0tq7f2k9aaaa', title: 'A'}));
    v.put('next/b.md', taskFile({id: '0tq7f2k9bbbb', title: 'B'}));
    v.put('waiting/c.md', taskFile({id: '0tq7f2k9cccc', title: 'C'}));
    v.put('someday/d.md', taskFile({id: '0tq7f2k9dddd', title: 'D'}));
    v.put('done/2026-09/e.md', taskFile({id: '0tq7f2k9eeee', title: 'E'}));

    const {tasks} = scan(v.dir);
    expect(tasks.map(t => t.task.state)).toEqual([
      'inbox',
      'next',
      'waiting',
      'someday',
      'done',
    ]);
  });

  test('takes state from the directory, so an agent moving a file is enough', () => {
    const v = openVault();
    v.put('next/a.md', taskFile({id: '0tq7f2k9aaaa', title: 'A'}));
    expect(scan(v.dir).tasks[0]?.task.state).toBe('next');

    // An agent completes it with nothing but `mv`.
    v.put('done/2026-09/a.md', taskFile({id: '0tq7f2k9aaaa', title: 'A'}));
    const moved = scan(v.dir).tasks.find(t => t.path.includes('done'));
    expect(moved?.task.state).toBe('done');
  });

  test('orders by id, which is creation order, so output never jitters', () => {
    const v = openVault();
    v.put('next/z.md', taskFile({id: '0tq7f2k9zzzz', title: 'Z'}));
    v.put('next/a.md', taskFile({id: '0tq7f2k9aaaa', title: 'A'}));
    expect(scan(v.dir).tasks.map(t => t.task.title)).toEqual(['A', 'Z']);
  });

  test('an empty vault scans to nothing rather than failing', () => {
    expect(scan(openVault().dir).tasks).toEqual([]);
  });

  test('a missing data directory scans to nothing rather than throwing', () => {
    expect(() => scan('/nonexistent/omni/dir')).not.toThrow();
    expect(scan('/nonexistent/omni/dir').tasks).toEqual([]);
  });
});

describe('what the scanner deliberately cannot see', () => {
  test('a half-written temp file', () => {
    const v = openVault();
    writeFileSync(join(v.dir, 'next', `${TEMP_PREFIX}inprogress`), '---\nid: broken');
    expect(scan(v.dir).tasks).toEqual([]);
    expect(scan(v.dir).damaged).toEqual([]);
  });

  test('a conflict backup', () => {
    const v = openVault();
    backupConflict(v.dir, 'a.md', taskFile({id: '0tq7f2k9aaaa', title: 'A'}), '2026-09-12T11:03:00Z');
    expect(scan(v.dir).tasks).toEqual([]);
  });

  test('a non-markdown file a person dropped in', () => {
    const v = openVault();
    v.put('next/notes.txt', 'just my notes');
    expect(scan(v.dir).tasks).toEqual([]);
  });

  test('a dotfile', () => {
    const v = openVault();
    v.put('next/.hidden.md', taskFile({id: '0tq7f2k9aaaa', title: 'A'}));
    expect(scan(v.dir).tasks).toEqual([]);
  });

  test('the contract and review documents the app itself owns', () => {
    const v = openVault();
    v.put('AGENTS.md', '# the contract');
    v.put('REVIEW.md', '# reviews');
    expect(scan(v.dir).tasks).toEqual([]);
  });

  test('a directory the app does not recognise', () => {
    const v = openVault();
    v.put('reference/wifi.md', taskFile({id: '0tq7f2k9aaaa', title: 'Wifi'}));
    v.put('my-own-folder/thing.md', taskFile({id: '0tq7f2k9bbbb', title: 'Thing'}));
    expect(scan(v.dir).tasks).toEqual([]);
  });

  test('a done folder that is not a month bucket', () => {
    const v = openVault();
    v.put('done/old/a.md', taskFile({id: '0tq7f2k9aaaa', title: 'A'}));
    v.put('done/loose.md', taskFile({id: '0tq7f2k9bbbb', title: 'Loose'}));
    expect(scan(v.dir).tasks).toEqual([]);
  });

  test('a file nested below a state directory', () => {
    const v = openVault();
    v.put('next/sub/a.md', taskFile({id: '0tq7f2k9aaaa', title: 'A'}));
    expect(scan(v.dir).tasks).toEqual([]);
  });
});

describe('files that need healing are read, not rejected', () => {
  test('a bare note an agent dropped in becomes a task', () => {
    const v = openVault();
    v.put('inbox/pick-up-milk.md', 'Pick up the milk on the way home.\n');

    const {tasks} = scan(v.dir);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]?.task.id).toBe('zzzzzzzzzzzz');
    expect(tasks[0]?.task.title).toBe('Pick up milk');
    expect(tasks[0]?.task.repairs.length).toBeGreaterThan(0);
  });

  test('an empty file is still a task', () => {
    const v = openVault();
    v.put('inbox/think-about-it.md', '');
    expect(scan(v.dir).tasks).toHaveLength(1);
  });
});

describe('damaged files are reported and left alone', () => {
  test('frontmatter that does not parse is reported, not read', () => {
    const v = openVault();
    v.put('next/broken.md', '---\ntitle: Call Bob re: budget\nid: x\n---\n');

    const {tasks, damaged} = scan(v.dir);
    expect(tasks).toEqual([]);
    expect(damaged).toHaveLength(1);
    expect(damaged[0]?.stem).toBe('broken');
    expect(damaged[0]?.reason).toContain('did not parse');
  });

  test('one damaged file does not stop the others being read', () => {
    const v = openVault();
    v.put('next/broken.md', '---\ntitle: a: b: c\n---\n');
    v.put('next/fine.md', taskFile({id: '0tq7f2k9aaaa', title: 'Fine'}));

    const {tasks, damaged} = scan(v.dir);
    expect(tasks.map(t => t.task.title)).toEqual(['Fine']);
    expect(damaged).toHaveLength(1);
  });
});

describe('incremental rescanning', () => {
  test('reuses a parse when mtime and size have not moved', () => {
    const v = openVault();
    v.put('next/a.md', taskFile({id: '0tq7f2k9aaaa', title: 'A'}));

    const first = scan(v.dir);
    const previous = new Map(first.tasks.map(t => [t.path, t]));
    const second = scanTasks(v.dir, {previous, mint: () => 'zzzzzzzzzzzz'});

    expect(second.tasks[0]).toBe(first.tasks[0]!); // the very same object
  });

  test('re-parses a file an agent rewrote', () => {
    const v = openVault();
    v.put('next/a.md', taskFile({id: '0tq7f2k9aaaa', title: 'A'}));

    const first = scan(v.dir);
    const previous = new Map(first.tasks.map(t => [t.path, t]));

    v.put('next/a.md', taskFile({id: '0tq7f2k9aaaa', title: 'A changed by an agent'}));
    const second = scanTasks(v.dir, {previous, mint: () => 'zzzzzzzzzzzz'});

    expect(second.tasks[0]?.task.title).toBe('A changed by an agent');
  });

  test('re-parses when the same path changed state', () => {
    const v = openVault();
    v.put('next/a.md', taskFile({id: '0tq7f2k9aaaa', title: 'A'}));
    const first = scan(v.dir);

    // A cached entry keyed by path must not survive the file being in a new state.
    const stale = new Map(
      first.tasks.map(t => [join(v.dir, 'inbox', 'a.md'), {...t, path: join(v.dir, 'inbox', 'a.md')}]),
    );
    mkdirSync(join(v.dir, 'inbox'), {recursive: true});
    v.put('inbox/a.md', taskFile({id: '0tq7f2k9aaaa', title: 'A'}));

    const second = scanTasks(v.dir, {previous: stale, mint: () => 'zzzzzzzzzzzz'});
    const inInbox = second.tasks.find(t => t.path.includes('inbox'));
    expect(inInbox?.task.state).toBe('inbox');
  });
});
