import {afterEach, describe, expect, test} from 'bun:test';
import {existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
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
    expect(h.run('status')).toBe(0);
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
