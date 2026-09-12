/**
 * Direct file operations, which are now the fallback rather than the interface.
 *
 * Agents are told to go through `omni` so their writes take the lock. But the data is
 * still plain markdown that a person edits in vim, that a script touches with `mv`, and
 * that an older agent may have been written against. All of that has to keep working,
 * because the alternative is an app that corrupts or rejects its own files the moment
 * something touches them from outside.
 *
 * So these tests do the crude thing on purpose: move files, append to logs with a shell
 * redirect, drop in notes with no frontmatter. What they prove is tolerance, not the
 * sanctioned path. `tests/e2e/contract.test.ts` covers the sanctioned path, and
 * `tests/e2e/concurrency.test.ts` covers why it is worth using.
 */
import {afterEach, describe, expect, test} from 'bun:test';
import {appendFileSync, mkdirSync, readFileSync, readdirSync, renameSync} from 'node:fs';
import {join} from 'node:path';
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

/** Plain file operations, the way something outside `omni` would do it. */
const agent = {
  findWork(dataDir: string, tag: string): string[] {
    const dir = join(dataDir, 'next');
    return readdirSync(dir)
      .filter(name => name.endsWith('.md'))
      .map(name => join(dir, name))
      .filter(path => {
        const raw = readFileSync(path, 'utf8');
        const frontmatter = raw.split('---')[1] ?? '';
        return new RegExp(`\\b${tag}\\b`).test(frontmatter);
      })
      .sort();
  },

  complete(dataDir: string, path: string, note: string, at: string): string {
    const raw = readFileSync(path, 'utf8');

    // Step one: record what was done. The log is the last section, so this is a
    // plain append that cannot disturb the frontmatter.
    if (!/^##\s+log\s*$/im.test(raw)) appendFileSync(path, '\n## Log\n');
    appendFileSync(path, `\n- ${at} **agent:test-agent** — ${note}\n`);

    // Step two: file it under the UTC month it was completed in.
    const month = at.slice(0, 7);
    const destination = join(dataDir, 'done', month, path.split('/').pop()!);
    mkdirSync(join(dataDir, 'done', month), {recursive: true});
    renameSync(path, destination);
    return destination;
  },
};

describe('an outside writer using only file operations', () => {
  test('moving a file and appending a log entry is still understood by omni', async () => {
    const v = openVault();
    await omni(['init'], {dir: v.dir, now: NOW});
    await omni(['add', 'Fix printer driver', '-t', 'home,agent', '--next'], {dir: v.dir, now: NOW});
    await omni(['add', 'Write the eulogy', '-t', 'personal', '--next'], {dir: v.dir, now: NOW});

    // --- everything below is done without omni ---
    const work = agent.findWork(v.dir, 'agent');
    expect(work).toHaveLength(1);
    expect(work[0]).toContain('fix-printer-driver.md');

    agent.complete(v.dir, work[0]!, 'Installed vendor PPD 4.2, test page prints clean.', NOW);
    // --- outside writer done ---

    const done = await omni(['list', 'state:done'], {dir: v.dir, now: NOW});
    expect(done.stdout).toContain('Fix printer driver');

    const next = await omni(['next'], {dir: v.dir, now: NOW});
    expect(next.stdout).not.toContain('Fix printer driver');
    expect(next.stdout).toContain('Write the eulogy');

    const shown = await omni(['show', 'fix-printer-driver'], {dir: v.dir, now: NOW});
    expect(shown.stdout).toContain('**agent:test-agent** — Installed vendor PPD 4.2');
  });

  test('the note and its author survive intact', async () => {
    const v = openVault();
    await omni(['init'], {dir: v.dir, now: NOW});
    await omni(['add', 'Rotate the API key', '-t', 'agent', '--next'], {dir: v.dir, now: NOW});

    const [path] = agent.findWork(v.dir, 'agent');
    const landed = agent.complete(v.dir, path!, 'Rotated, old key revoked at 11:02Z.', NOW);

    const written = readFileSync(landed, 'utf8');
    expect(written).toContain('- 2026-09-12T11:03:00Z **agent:test-agent** — Rotated, old key revoked at 11:02Z.');
    // The append must be the last thing in the file, which is what makes it safe.
    expect(written.trimEnd().endsWith('old key revoked at 11:02Z.')).toBe(true);
  });

  test('omni fills in the done date the agent did not bother to set', async () => {
    const v = openVault();
    await omni(['init'], {dir: v.dir, now: NOW});
    await omni(['add', 'Tidy the logs', '-t', 'agent', '--next'], {dir: v.dir, now: NOW});

    const [path] = agent.findWork(v.dir, 'agent');
    agent.complete(v.dir, path!, 'Rotated and compressed.', NOW);

    // The agent never wrote a `done:` field. Reading supplies one.
    const before = readFileSync(join(v.dir, 'done', '2026-09', 'tidy-the-logs.md'), 'utf8');
    expect(before).not.toContain('done:');

    const fixed = await omni(['doctor', '--fix'], {dir: v.dir, now: NOW});
    expect(fixed.code).toBe(0);
    expect(readFileSync(join(v.dir, 'done', '2026-09', 'tidy-the-logs.md'), 'utf8')).toContain('done:');
  });

  test('a deferred task is not visible in next, so the agent cannot take it early', async () => {
    const v = openVault();
    await omni(['init'], {dir: v.dir, now: NOW});
    await omni(['add', 'Renew the domain', '-t', 'agent', '-s', 'someday', '--defer', '2027-01-01'], {
      dir: v.dir,
      now: NOW,
    });

    // The whole point of keeping `defer` out of next/: an agent listing that directory
    // literally must never see work that is not ready.
    expect(agent.findWork(v.dir, 'agent')).toEqual([]);
  });

  test('an agent can capture a task with no frontmatter at all', async () => {
    const v = openVault();
    await omni(['init'], {dir: v.dir, now: NOW});

    // The laziest possible capture, which the contract explicitly permits.
    v.put('inbox/investigate-the-flaky-test.md', 'It fails about one run in twenty.\n');

    const listed = await omni(['inbox'], {dir: v.dir, now: NOW});
    expect(listed.stdout).toContain('Investigate the flaky test');

    await omni(['doctor', '--fix'], {dir: v.dir, now: NOW});
    const healed = v.read('inbox/investigate-the-flaky-test.md');
    expect(healed).toContain('id:');
    expect(healed).toContain('title: Investigate the flaky test');
    expect(healed).toContain('It fails about one run in twenty.');
  });

  test('an agent moving a file is enough to change a task\'s state', async () => {
    const v = openVault();
    await omni(['init'], {dir: v.dir, now: NOW});
    await omni(['add', 'Think about the redesign'], {dir: v.dir, now: NOW});

    renameSync(
      join(v.dir, 'inbox', 'think-about-the-redesign.md'),
      join(v.dir, 'someday', 'think-about-the-redesign.md'),
    );

    const someday = await omni(['someday'], {dir: v.dir, now: NOW});
    expect(someday.stdout).toContain('Think about the redesign');
    const inbox = await omni(['inbox'], {dir: v.dir, now: NOW});
    expect(inbox.stdout).toBe('Inbox zero.');
  });
});

describe('the app tolerates edits made from outside it', () => {
  test('an append by an agent survives omni editing the frontmatter', async () => {
    const v = openVault();
    await omni(['init'], {dir: v.dir, now: NOW});
    await omni(['add', 'Shared task', '-t', 'agent', '--next'], {dir: v.dir, now: NOW});

    const path = join(v.dir, 'next', 'shared-task.md');
    appendFileSync(path, '\n## Log\n\n- 2026-09-12T10:00:00Z **agent:test-agent** — Started looking.\n');

    // omni now edits the other end of the file.
    await omni(['tag', 'shared-task', '+urgent'], {dir: v.dir, now: NOW});

    const written = readFileSync(path, 'utf8');
    expect(written).toContain('Started looking.');
    expect(written).toContain('urgent');
  });

  test('a task an agent completed mid-session is reported, not lost', async () => {
    const v = openVault();
    await omni(['init'], {dir: v.dir, now: NOW});
    await omni(['add', 'Racy task', '-t', 'agent', '--next'], {dir: v.dir, now: NOW});

    const [path] = agent.findWork(v.dir, 'agent');
    agent.complete(v.dir, path!, 'Got there first.', NOW);

    // The task is gone from next/, so completing it again fails cleanly rather than
    // resurrecting it or crashing.
    const result = await omni(['done', 'racy-task'], {dir: v.dir, now: NOW});
    expect(result.stdout + result.stderr).toContain('already done');
    expect(v.list()).toEqual(['done/2026-09/racy-task.md']);
  });
});
