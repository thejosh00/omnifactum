/**
 * Driving the CLI in tests.
 *
 * `omni` runs the command in-process, which is fast enough to use freely. `omniSpawn`
 * runs the real binary in a child process, which is what proves the thing a user
 * actually installs works, including its exit code.
 */
import {run} from '../../src/cli.ts';

export interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface CliOptions {
  dir: string;
  /** A fixed clock, so completion months and log timestamps are predictable. */
  now?: string;
}

export async function omni(args: readonly string[], options: CliOptions): Promise<CliResult> {
  const stdout: string[] = [];
  const stderr: string[] = [];

  const previous = process.env['OMNI_DIR'];
  process.env['OMNI_DIR'] = options.dir;
  try {
    const code = await run({
      argv: args,
      out: line => stdout.push(line ?? ''),
      err: line => stderr.push(line ?? ''),
      ...(options.now === undefined ? {} : {now: () => options.now!}),
      // Never launch the real interface from a test.
      interactive: async () => 0,
    });
    return {code, stdout: stdout.join('\n'), stderr: stderr.join('\n')};
  } finally {
    if (previous === undefined) delete process.env['OMNI_DIR'];
    else process.env['OMNI_DIR'] = previous;
  }
}

/** Run the real `src/cli.ts` as a child process, the way a user would. */
export async function omniSpawn(args: readonly string[], options: CliOptions): Promise<CliResult> {
  const proc = Bun.spawn(['bun', 'run', 'src/cli.ts', ...args], {
    env: {...process.env, OMNI_DIR: options.dir, NO_COLOR: '1'},
    stdout: 'pipe',
    stderr: 'pipe',
  });

  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  return {code, stdout: stdout.trimEnd(), stderr: stderr.trimEnd()};
}
