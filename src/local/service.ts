/**
 * `omni service`: keep `omni serve` running in the background on macOS.
 *
 * It installs a launch agent, so the server starts when you log in and comes back by
 * itself if it ever stops. The other subcommands are thin wrappers over `launchctl`, so
 * nobody has to remember its syntax.
 *
 * The agent runs whichever `omni` installed it: the compiled binary if that is what ran
 * `install`, otherwise Bun on this checkout's `src/cli.ts` — in which case a code change
 * takes effect on `omni service restart`, with no rebuild.
 */
import {existsSync, mkdirSync, unlinkSync, writeFileSync} from 'node:fs';
import {homedir} from 'node:os';
import {basename, join, resolve} from 'node:path';
import {flagValue, parseArgs} from '../core/args.ts';
import {listBackups} from '../db/backup.ts';
import {EXIT_ERROR, EXIT_OK, EXIT_USAGE} from '../commands/context.ts';

export const SERVICE_LABEL = 'com.omnifactum.serve';

export interface ServiceSpec {
  /** The program and arguments that start the server. */
  command: string[];
  dataDir: string;
  logPath: string;
  path: string;
}

function escapeXml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** The launch agent, as XML. Pure, so its shape is an ordinary test. */
export function servicePlist(spec: ServiceSpec): string {
  const strings = (values: string[]) => values.map(value => `\t\t<string>${escapeXml(value)}</string>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
\t<key>Label</key>
\t<string>${SERVICE_LABEL}</string>
\t<key>ProgramArguments</key>
\t<array>
${strings(spec.command)}
\t</array>
\t<key>RunAtLoad</key>
\t<true/>
\t<key>KeepAlive</key>
\t<true/>
\t<key>ThrottleInterval</key>
\t<integer>10</integer>
\t<key>EnvironmentVariables</key>
\t<dict>
\t\t<key>PATH</key>
\t\t<string>${escapeXml(spec.path)}</string>
\t\t<key>OMNI_DIR</key>
\t\t<string>${escapeXml(spec.dataDir)}</string>
\t</dict>
\t<key>WorkingDirectory</key>
\t<string>${escapeXml(spec.dataDir)}</string>
\t<key>StandardOutPath</key>
\t<string>${escapeXml(spec.logPath)}</string>
\t<key>StandardErrorPath</key>
\t<string>${escapeXml(spec.logPath)}</string>
</dict>
</plist>
`;
}

/**
 * How this process was started, so the agent can start the same thing.
 *
 * For Bun, the copy on PATH is preferred to the one actually running: Homebrew runs Bun
 * from a versioned Cellar directory that vanishes on the next `brew upgrade`, and an
 * agent pointing there would stop starting without saying why.
 */
export function serveCommand(execPath: string, cliPath: string, extra: string[], bunOnPath?: string | null): string[] {
  const compiled = !basename(execPath).startsWith('bun');
  if (compiled) return [execPath, 'serve', ...extra];
  return [bunOnPath ?? execPath, cliPath, 'serve', ...extra];
}

export interface Launchctl {
  (args: string[]): {code: number; stdout: string; stderr: string};
}

const realLaunchctl: Launchctl = args => {
  const result = Bun.spawnSync(['launchctl', ...args], {stdout: 'pipe', stderr: 'pipe'});
  return {code: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString()};
};

export interface ServiceContext {
  dataDir: string;
  out: (line?: string) => void;
  err: (line?: string) => void;
  launchctl?: Launchctl;
  /** Where launch agents live; injected by tests. */
  agentsDir?: string;
  platform?: string;
  uid?: number;
  execPath?: string;
}

const USAGE = [
  'usage: omni service <command>',
  '  install [--host h] [--port p]   run the server in the background, now and at login',
  '  uninstall                       stop it and remove the launch agent',
  '  start | stop | restart          start, stop (until next login), or restart it',
  '  status                          whether it is running',
  '  logs                            follow the server log',
].join('\n');

export function serviceCommand(ctx: ServiceContext, argv: readonly string[]): number {
  const platform = ctx.platform ?? process.platform;
  if (platform !== 'darwin') {
    ctx.err('omni service uses launchd, which only exists on macOS; run "omni serve" under your own supervisor');
    return EXIT_ERROR;
  }

  const args = parseArgs(argv, {alias: {p: 'port', H: 'host'}});
  const [sub] = args.positional;
  const launchctl = ctx.launchctl ?? realLaunchctl;
  const domain = `gui/${ctx.uid ?? process.getuid?.() ?? 501}`;
  const target = `${domain}/${SERVICE_LABEL}`;
  const plistPath = join(ctx.agentsDir ?? join(homedir(), 'Library', 'LaunchAgents'), `${SERVICE_LABEL}.plist`);
  const logPath = join(ctx.dataDir, 'logs', 'serve.log');
  const loaded = () => launchctl(['print', target]).code === 0;

  const bootstrap = (): number => {
    const result = launchctl(['bootstrap', domain, plistPath]);
    if (result.code !== 0) {
      ctx.err(`launchctl could not start it: ${result.stderr.trim() || `exit ${result.code}`}`);
      ctx.err(`see ${logPath}`);
      return EXIT_ERROR;
    }
    return EXIT_OK;
  };

  switch (sub) {
    case 'install': {
      const extra: string[] = [];
      const host = flagValue(args, 'host');
      const port = flagValue(args, 'port');
      if (host !== undefined) extra.push('--host', host);
      if (port !== undefined) extra.push('--port', port);

      const cliPath = resolve(import.meta.dir, '..', 'cli.ts');
      const spec: ServiceSpec = {
        command: serveCommand(ctx.execPath ?? process.execPath, cliPath, extra, ctx.execPath === undefined ? Bun.which('bun') : undefined),
        dataDir: ctx.dataDir,
        logPath,
        path: '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin',
      };

      mkdirSync(join(ctx.dataDir, 'logs'), {recursive: true});
      mkdirSync(join(plistPath, '..'), {recursive: true});
      // Replace, never stack: an older agent is unloaded before the new one goes in.
      if (loaded()) launchctl(['bootout', target]);
      writeFileSync(plistPath, servicePlist(spec));
      if (bootstrap() !== EXIT_OK) return EXIT_ERROR;

      ctx.out(`installed ${plistPath}`);
      ctx.out(`omni now runs in the background, and starts when you log in`);
      ctx.out(`  runs:  ${spec.command.join(' ')}`);
      ctx.out(`  log:   ${logPath}`);
      return EXIT_OK;
    }

    case 'uninstall': {
      if (loaded()) launchctl(['bootout', target]);
      if (existsSync(plistPath)) unlinkSync(plistPath);
      ctx.out('uninstalled; omni no longer runs in the background');
      return EXIT_OK;
    }

    case 'start': {
      if (!existsSync(plistPath)) {
        ctx.err('not installed yet: run "omni service install"');
        return EXIT_ERROR;
      }
      if (loaded()) {
        ctx.out('already running');
        return EXIT_OK;
      }
      if (bootstrap() !== EXIT_OK) return EXIT_ERROR;
      ctx.out('started');
      return EXIT_OK;
    }

    case 'stop': {
      if (!loaded()) {
        ctx.out('not running');
        return EXIT_OK;
      }
      launchctl(['bootout', target]);
      ctx.out('stopped; it starts again at your next login, or with "omni service start"');
      return EXIT_OK;
    }

    case 'restart': {
      if (!loaded()) {
        if (!existsSync(plistPath)) {
          ctx.err('not installed yet: run "omni service install"');
          return EXIT_ERROR;
        }
        if (bootstrap() !== EXIT_OK) return EXIT_ERROR;
        ctx.out('started');
        return EXIT_OK;
      }
      const result = launchctl(['kickstart', '-k', target]);
      if (result.code !== 0) {
        ctx.err(`launchctl could not restart it: ${result.stderr.trim()}`);
        return EXIT_ERROR;
      }
      ctx.out('restarted');
      return EXIT_OK;
    }

    case 'status': {
      // Always exits 0: it answers a question, and "not running" is a fine answer.
      if (!existsSync(plistPath)) {
        ctx.out('not installed');
        return EXIT_OK;
      }
      const printed = launchctl(['print', target]);
      if (printed.code !== 0) {
        ctx.out('installed, not running');
        return EXIT_OK;
      }
      const pid = /\bpid = (\d+)/.exec(printed.stdout)?.[1];
      const runs = /\bruns = (\d+)/.exec(printed.stdout)?.[1];
      ctx.out(pid === undefined ? 'installed, waiting to restart' : `running, pid ${pid}`);
      const restarts = runs === undefined ? 0 : Number(runs) - 1;
      if (restarts > 0) ctx.out(`restarted ${restarts === 1 ? 'once' : `${restarts} times`} since it was loaded`);
      const latest = listBackups(ctx.dataDir)[0];
      ctx.out(latest === undefined ? 'no backups yet' : `last backup: ${latest.name}, ${latest.modified.toLocaleString()}`);
      ctx.out(`log: ${logPath}`);
      return EXIT_OK;
    }

    case 'logs': {
      const tail = Bun.spawnSync(['tail', '-n', '50', '-f', logPath], {stdout: 'inherit', stderr: 'inherit'});
      return tail.exitCode ?? EXIT_OK;
    }

    default:
      ctx.err(USAGE);
      return EXIT_USAGE;
  }
}
