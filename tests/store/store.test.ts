import {afterEach, describe, expect, test} from 'bun:test';
import {existsSync} from 'node:fs';
import {planComplete, planMove, planNewTask, planSetTitle} from '../../src/core/mutation.ts';
import {Store} from '../../src/store/store.ts';
import {StaleWriteError} from '../../src/store/write.ts';
import {makeVault, taskFile, type Vault} from '../helpers/vault.ts';

const NOW = '2026-09-12T11:03:00Z';

let vault: Vault | undefined;

function openStore(): {store: Store; v: Vault} {
  vault = makeVault();
  const store = new Store(vault.dir, {now: () => NOW, mint: () => '0tq7f2k9aaaa'});
  store.ensureLayout();
  return {store, v: vault};
}

afterEach(() => {
  vault?.cleanup();
  vault = undefined;
});

const newTask = (title: string, overrides: Record<string, unknown> = {}) =>
  planNewTask({id: '0tq7f2k9aaaa', title, state: 'inbox', nowIso: NOW, ...overrides});

describe('ensureLayout', () => {
  test('creates every directory a file can be filed under', () => {
    const {v} = openStore();
    for (const dir of ['inbox', 'next', 'waiting', 'someday', 'done', 'projects/active']) {
      expect(existsSync(`${v.dir}/${dir}`)).toBe(true);
    }
  });

  test('is safe to run again', () => {
    const {store, v} = openStore();
    v.put('next/a.md', taskFile({id: '0tq7f2k9bbbb', title: 'A'}));
    store.ensureLayout();
    expect(v.exists('next/a.md')).toBe(true);
  });
});

describe('create', () => {
  test('writes a readable file named after the title', () => {
    const {store, v} = openStore();
    const file = store.create(newTask('Fix printer driver'));

    expect(file.stem).toBe('fix-printer-driver');
    expect(v.list()).toEqual(['inbox/fix-printer-driver.md']);
    expect(v.read('inbox/fix-printer-driver.md')).toBe(
      '---\nid: 0tq7f2k9aaaa\ntitle: Fix printer driver\ncreated: 2026-09-12T11:03:00Z\n---\n',
    );
  });

  test('suffixes rather than overwriting a name already in use', () => {
    const {store, v} = openStore();
    store.create(newTask('Fix printer'));
    store.create(planNewTask({id: '0tq7f2k9bbbb', title: 'Fix printer', state: 'inbox', nowIso: NOW}));

    expect(v.list().sort()).toEqual(['inbox/fix-printer-2.md', 'inbox/fix-printer.md']);
  });

  test('files a completed task under its UTC month', () => {
    const {store, v} = openStore();
    store.create(newTask('Already done', {state: 'done'}));
    expect(v.list()).toEqual(['done/2026-09/already-done.md']);
  });

  test('is found by the very next load', () => {
    const {store} = openStore();
    store.create(newTask('Fix printer'));
    expect(store.load().tasks.map(f => f.task.title)).toEqual(['Fix printer']);
  });
});

describe('apply', () => {
  test('an unchanged task rewrites nothing', () => {
    const {store, v} = openStore();
    const original = v.put('next/a.md', taskFile({id: '0tq7f2k9bbbb', title: 'A'}));
    const before = v.read('next/a.md');

    const file = store.load().tasks[0]!;
    store.apply(file, file.task);

    expect(v.read('next/a.md')).toBe(before);
    expect(existsSync(original)).toBe(true);
  });

  test('renames the file when it renamed the file in the first place', () => {
    const {store, v} = openStore();
    v.put('next/fix-printer.md', taskFile({id: '0tq7f2k9bbbb', title: 'Fix printer'}));

    const file = store.load().tasks[0]!;
    store.apply(file, planSetTitle(file.task, 'Fix the laser printer'));

    expect(v.list()).toEqual(['next/fix-the-laser-printer.md']);
  });

  test('leaves a name a human chose alone, forever', () => {
    const {store, v} = openStore();
    v.put('next/URGENT-thing.md', taskFile({id: '0tq7f2k9bbbb', title: 'Fix printer'}));

    const file = store.load().tasks[0]!;
    store.apply(file, planSetTitle(file.task, 'Fix the laser printer'));

    expect(v.list()).toEqual(['next/URGENT-thing.md']);
    expect(v.read('next/URGENT-thing.md')).toContain('title: Fix the laser printer');
  });

  test('moving a task changes only its directory', () => {
    const {store, v} = openStore();
    v.put('inbox/call-bank.md', taskFile({id: '0tq7f2k9bbbb', title: 'Call bank'}));

    const file = store.load().tasks[0]!;
    store.apply(file, planMove(file.task, 'next', {nowIso: NOW}));

    expect(v.list()).toEqual(['next/call-bank.md']);
  });

  test('completing files the task under its month and records the note', () => {
    const {store, v} = openStore();
    v.put('next/fix-printer.md', taskFile({id: '0tq7f2k9bbbb', title: 'Fix printer'}));

    const file = store.load().tasks[0]!;
    store.apply(
      file,
      planComplete(file.task, {nowIso: NOW, actor: 'agent:claude-code', note: 'Installed PPD 4.2.'}),
    );

    expect(v.list()).toEqual(['done/2026-09/fix-printer.md']);
    const written = v.read('done/2026-09/fix-printer.md');
    expect(written).toContain('done: 2026-09-12T11:03:00Z');
    expect(written).toContain('**agent:claude-code** — Installed PPD 4.2.');
    expect(written.trimEnd().endsWith('Installed PPD 4.2.')).toBe(true);
  });

  test('a task is never in two directories at once', () => {
    const {store, v} = openStore();
    v.put('next/a.md', taskFile({id: '0tq7f2k9bbbb', title: 'A'}));

    const file = store.load().tasks[0]!;
    store.apply(file, planComplete(file.task, {nowIso: NOW}));

    expect(v.list()).toHaveLength(1);
  });

  test('suffixes when the destination name is taken', () => {
    const {store, v} = openStore();
    v.put('next/a.md', taskFile({id: '0tq7f2k9bbbb', title: 'A'}));
    v.put('done/2026-09/a.md', taskFile({id: '0tq7f2k9cccc', title: 'A', created: '2026-09-01T00:00:00Z'}));

    const file = store.load().tasks.find(f => f.task.state === 'next')!;
    store.apply(file, planComplete(file.task, {nowIso: NOW}));

    expect(v.list().sort()).toEqual(['done/2026-09/a-2.md', 'done/2026-09/a.md']);
  });

  test('refuses to clobber an edit that landed while we were thinking', () => {
    const {store, v} = openStore();
    v.put('next/a.md', taskFile({id: '0tq7f2k9bbbb', title: 'A'}));
    const file = store.load().tasks[0]!;

    // An agent rewrites the file after we read it but before we write.
    v.put('next/a.md', taskFile({id: '0tq7f2k9bbbb', title: 'A, edited by an agent elsewhere'}));

    expect(() => store.apply(file, planSetTitle(file.task, 'Mine'))).toThrow(StaleWriteError);
    expect(v.read('next/a.md')).toContain('edited by an agent elsewhere');
  });
});

describe('heal', () => {
  test('turns a bare agent-written note into a proper task file', () => {
    const {store, v} = openStore();
    v.put('inbox/pick-up-milk.md', 'Pick up the milk.\n');

    const file = store.load().tasks[0]!;
    expect(file.task.repairs.length).toBeGreaterThan(0);
    store.heal(file);

    const healed = v.read('inbox/pick-up-milk.md');
    expect(healed).toContain('id: 0tq7f2k9aaaa');
    expect(healed).toContain('title: Pick up milk');
    expect(healed).toContain('Pick up the milk.');

    store.invalidate();
    expect(store.load().tasks[0]?.task.repairs).toEqual([]);
  });
});

describe('remove', () => {
  test('deletes for real, because there is no trash by decision', () => {
    const {store, v} = openStore();
    v.put('inbox/a.md', taskFile({id: '0tq7f2k9bbbb', title: 'A'}));

    const file = store.load().tasks[0]!;
    store.remove(file);

    expect(v.list()).toEqual([]);
    expect(store.load().tasks).toEqual([]);
  });
});

describe('load', () => {
  test('reports a duplicate id rather than hiding it', () => {
    const {store, v} = openStore();
    v.put('next/a.md', taskFile({id: '0tq7f2k9bbbb', title: 'A'}));
    v.put('next/b.md', taskFile({id: '0tq7f2k9bbbb', title: 'B'}));

    expect(store.load().duplicateIds).toEqual(['0tq7f2k9bbbb']);
  });

  test('groups tasks by state and counts tags', () => {
    const {store, v} = openStore();
    v.put('next/a.md', taskFile({id: '0tq7f2k9bbbb', title: 'A', tags: ['home', 'agent']}));
    v.put('inbox/b.md', taskFile({id: '0tq7f2k9cccc', title: 'B', tags: ['home']}));

    const snapshot = store.load();
    expect(snapshot.byState.get('next')).toHaveLength(1);
    expect(snapshot.tags[0]).toMatchObject({tag: 'home', count: 2});
  });

  test('surfaces files that still need healing', () => {
    const {store, v} = openStore();
    v.put('inbox/bare.md', 'no frontmatter here\n');
    expect(store.load().needHealing).toHaveLength(1);
  });
});
