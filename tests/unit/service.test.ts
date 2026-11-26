import {afterEach, describe, expect, test} from 'bun:test';
import {existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {
  SERVICE_LABEL,
  serveCommand,
  serviceCommand,
  servicePlist,
  type Launchctl,
  type ServiceContext,
} from '../../src/local/service.ts';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, {recursive: true, force: true});
});

/** A fake launchctl that remembers whether the agent is loaded, and every call made. */
function harness(options: {loaded?: boolean} = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'omni-service-'));
  dirs.push(dir);
  let loaded = options.loaded ?? false;
  const calls: string[][] = [];
  const launchctl: Launchctl = args => {
    calls.push(args);
    switch (args[0]) {
      case 'print':
        return loaded
          ? {code: 0, stdout: 'state = running\n\tpid = 4242\n\truns = 3\n', stderr: ''}
          : {code: 113, stdout: '', stderr: 'Could not find service'};
      case 'bootstrap':
        loaded = true;
        return {code: 0, stdout: '', stderr: ''};
      case 'bootout':
        loaded = false;
        return {code: 0, stdout: '', stderr: ''};
      default:
        return {code: 0, stdout: '', stderr: ''};
    }
  };
  const out: string[] = [];
  const err: string[] = [];
  const ctx: ServiceContext = {
    dataDir: join(dir, 'data'),
    agentsDir: join(dir, 'LaunchAgents'),
    platform: 'darwin',
    uid: 501,
    execPath: '/opt/homebrew/bin/bun',
    launchctl,
    out: line => out.push(line ?? ''),
    err: line => err.push(line ?? ''),
  };
  const plist = join(dir, 'LaunchAgents', `${SERVICE_LABEL}.plist`);
  return {ctx, calls, out, err, plist, run: (...argv: string[]) => serviceCommand(ctx, argv)};
}

describe('the launch agent it writes', () => {
  test('is a valid property list that keeps the server alive and logs to the data dir', () => {
    const xml = servicePlist({
      command: ['/opt/homebrew/bin/bun', '/repo/src/cli.ts', 'serve'],
      dataDir: '/Users/you/.omnifactum',
      logPath: '/Users/you/.omnifactum/logs/serve.log',
      path: '/usr/bin:/bin',
    });
    const dir = mkdtempSync(join(tmpdir(), 'omni-plist-'));
    dirs.push(dir);
    writeFileSync(join(dir, 'a.plist'), xml);
    if (process.platform === 'darwin') {
      expect(Bun.spawnSync(['plutil', '-lint', join(dir, 'a.plist')]).exitCode).toBe(0);
    }
    expect(xml).toContain('<key>KeepAlive</key>\n\t<true/>');
    expect(xml).toContain('<string>/Users/you/.omnifactum/logs/serve.log</string>');
    expect(xml).toContain('<key>OMNI_DIR</key>\n\t\t<string>/Users/you/.omnifactum</string>');
  });

  test('runs Bun on this checkout, or the compiled binary if that is what installed it', () => {
    expect(serveCommand('/opt/homebrew/bin/bun', '/repo/src/cli.ts', [])).toEqual([
      '/opt/homebrew/bin/bun',
      '/repo/src/cli.ts',
      'serve',
    ]);
    expect(serveCommand('/opt/homebrew/Cellar/bun/1.4.2/bin/bun', '/repo/src/cli.ts', [], '/opt/homebrew/bin/bun')[0]).toBe(
      '/opt/homebrew/bin/bun',
    );
    expect(serveCommand('/usr/local/bin/omni', '/$bunfs/cli.ts', ['--port', '8000'])).toEqual([
      '/usr/local/bin/omni',
      'serve',
      '--port',
      '8000',
    ]);
  });
});

describe('omni service', () => {
  test('install writes the agent, loads it, and passes host and port through', () => {
    const h = harness();
    expect(h.run('install', '--port', '8000')).toBe(0);
    expect(readFileSync(h.plist, 'utf8')).toContain('<string>8000</string>');
    expect(h.calls).toContainEqual(['bootstrap', 'gui/501', h.plist]);
    expect(existsSync(join(h.ctx.dataDir, 'logs'))).toBe(true);
  });

  test('install passes --allowed-hosts through to omni serve (R2)', () => {
    const h = harness();
    expect(h.run('install', '--host', '0.0.0.0', '--allowed-hosts', 'mymac.local')).toBe(0);
    const plist = readFileSync(h.plist, 'utf8');
    expect(plist).toContain('<string>--allowed-hosts</string>');
    expect(plist).toContain('<string>mymac.local</string>');
  });

  test('installing again replaces the running agent rather than stacking a second', () => {
    const h = harness({loaded: true});
    h.run('install');
    const verbs = h.calls.map(call => call[0]);
    expect(verbs.indexOf('bootout')).toBeLessThan(verbs.indexOf('bootstrap'));
  });

  test('start, stop and restart map onto launchctl', () => {
    const h = harness();
    h.run('install');
    h.calls.length = 0;

    expect(h.run('stop')).toBe(0);
    expect(h.calls.at(-1)).toEqual(['bootout', `gui/501/${SERVICE_LABEL}`]);
    expect(h.run('start')).toBe(0);
    expect(h.calls.at(-1)).toEqual(['bootstrap', 'gui/501', h.plist]);
    expect(h.run('restart')).toBe(0);
    expect(h.calls.at(-1)).toEqual(['kickstart', '-k', `gui/501/${SERVICE_LABEL}`]);
  });

  test('status reports the pid and how often it has restarted', () => {
    const h = harness();
    h.run('install');
    // R30: status no longer always exits 0. It does here because no daily backup is stale
    // (a data folder this new has had no time to take one); a stale one exits 1, tested below.
    expect(h.run('status')).toBe(0);
    expect(h.out.some(line => line.startsWith('warning'))).toBe(false);
    expect(h.out).toContain('running, pid 4242');
    expect(h.out).toContain('restarted 2 times since it was loaded');
  });

  test('start before install says what to do', () => {
    const h = harness();
    expect(h.run('start')).not.toBe(0);
    expect(h.err.join('\n')).toContain('omni service install');
  });

  test('uninstall unloads it and removes the file', () => {
    const h = harness();
    h.run('install');
    expect(h.run('uninstall')).toBe(0);
    expect(existsSync(h.plist)).toBe(false);
  });

  test('anywhere but macOS it refuses rather than pretending', () => {
    const h = harness();
    expect(serviceCommand({...h.ctx, platform: 'linux'}, ['install'])).not.toBe(0);
    expect(h.calls).toEqual([]);
  });
});

/** `omni service status` against a data folder whose newest daily backup was written `hours` ago (none when undefined). */
function status(options: {backupHours?: number; manualHours?: number; dbHours?: number; installed?: boolean; running?: boolean}) {
  const dir = mkdtempSync(join(tmpdir(), 'omni-status-'));
  dirs.push(dir);
  const now = new Date('2026-09-12T15:00:00Z');
  const write = (path: string, hours: number) => {
    writeFileSync(path, '');
    const at = new Date(now.getTime() - hours * 3_600_000);
    utimesSync(path, at, at);
    return at;
  };
  mkdirSync(join(dir, 'backups'));
  mkdirSync(join(dir, 'agents'));
  // macOS moves a file's creation time back with its modification time, which is what makes the database "old".
  write(join(dir, 'omni.db'), options.dbHours ?? 1000);
  const written = options.backupHours === undefined ? undefined : write(join(dir, 'backups', 'omni-2026-09-10.db'), options.backupHours);
  if (options.manualHours !== undefined) {
    write(join(dir, 'backups', 'omni-2026-09-12T1400.db'), options.manualHours);
    write(join(dir, 'backups', 'omni-label-pre-migration-v3-20260912T140000.db'), options.manualHours);
  }
  if (options.installed !== false) writeFileSync(join(dir, 'agents', `${SERVICE_LABEL}.plist`), '');
  const out: string[] = [];
  const ctx = {
    dataDir: dir,
    agentsDir: join(dir, 'agents'),
    platform: 'darwin',
    uid: 501,
    now: () => now,
    out: (line?: string) => out.push(line ?? ''),
    err: () => {},
    launchctl: () => (options.running === false ? {code: 113, stdout: '', stderr: 'Could not find service'} : {code: 0, stdout: 'pid = 42', stderr: ''}),
  };
  const code = serviceCommand(ctx as ServiceContext, ['status']);
  return {code, out, written};
}

test('service status warns and exits 1 when the daily backup is stale, running or not', () => {
  const stale = status({backupHours: 37});
  expect(stale.out[0]).toBe('running, pid 42');
  expect(stale.out[1]).toStartWith('last backup: omni-2026-09-10.db');
  expect(stale.out[2]).toBe(`warning: no backup since ${stale.written!.toLocaleString()}: see serve.log`);
  expect(stale.code).toBe(1);
  // A fresh on-demand or pre-migration backup beside it changes nothing.
  const beside = status({backupHours: 37, manualHours: 1});
  expect(beside.out).toContain(`warning: no backup since ${beside.written!.toLocaleString()}: see serve.log`);
  expect(beside.code).toBe(1);
  // Installed but stopped: the backup line and the warning are still printed.
  const stopped = status({backupHours: 37, running: false});
  expect(stopped.out[0]).toBe('installed, not running');
  expect(stopped.out[1]).toStartWith('last backup: omni-2026-09-10.db');
  expect(stopped.out.some(line => line.startsWith('warning: no backup since'))).toBe(true);
  expect(stopped.code).toBe(1);
  // Not installed (omni serve under another supervisor): the backups are still the folder's.
  const bare = status({backupHours: 37, installed: false});
  expect(bare.out[0]).toBe('not installed');
  expect(bare.out.some(line => line.startsWith('warning: no backup since'))).toBe(true);
  expect(bare.code).toBe(1);
});

test('service status exits 0 without a warning when the daily backup is fresh', () => {
  for (const running of [true, false]) {
    const fresh = status({backupHours: 35, running});
    expect(fresh.out.some(line => line.startsWith('warning'))).toBe(false);
    expect(fresh.out[1]).toStartWith('last backup: omni-2026-09-10.db');
    expect(fresh.code).toBe(0);
  }
});

test('service status with no daily backup warns only when the database is itself more than 36 hours old', () => {
  const old = status({dbHours: 37});
  expect(old.out).toContain('no backups yet');
  expect(old.out).toContain('warning: no daily backup has been taken: see serve.log');
  expect(old.code).toBe(1);
  const young = status({dbHours: 35});
  expect(young.out).toContain('no backups yet');
  expect(young.out.some(line => line.startsWith('warning'))).toBe(false);
  expect(young.code).toBe(0);
});
