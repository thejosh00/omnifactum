/**
 * Starting the interactive interface.
 *
 * Kept behind a lazy import from `cli.ts` so a plain `omni add` never pays to load
 * React and Ink.
 */
import {render} from 'ink';
import {watchDataDir} from '../store/watch.ts';
import {App} from './app.tsx';
import {LiveStore} from './liveStore.ts';
import {EXIT_OK, loadWorld, type CommandContext} from '../commands/context.ts';

export async function startInteractive(ctx: CommandContext): Promise<number> {
  // Let any deferred task surface before the first frame, exactly as every other
  // command does, so the interface never shows a staler world than `omni next` would.
  loadWorld(ctx);

  if (process.stdout.isTTY !== true) {
    ctx.err('omni needs a terminal for its interactive interface');
    ctx.err('run "omni next" to list tasks, or "omni help" for everything else');
    return 1;
  }

  let live: LiveStore | undefined;
  const watcher = watchDataDir(
    ctx.dataDir,
    () => live?.refreshFromDisk(),
    {enabled: process.env['OMNI_NO_WATCH'] !== '1'},
  );

  live = new LiveStore(ctx.store, {now: ctx.now, watcher});

  const instance = render(<App live={live} watching={watcher.active} />, {
    exitOnCtrlC: true,
  });

  try {
    await instance.waitUntilExit();
  } finally {
    watcher.close();
  }

  return EXIT_OK;
}
