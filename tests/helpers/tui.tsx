/**
 * Driving the real Ink interface in tests.
 *
 * These render the actual components against a real temporary vault, so a key sequence
 * exercises the components, the keymap, the store, and the filesystem together. What
 * they cannot cover is raw mode, terminal resize, and the `$EDITOR` handoff, which need
 * a real pty; those have a manual smoke check in the README instead.
 */
import {render} from 'ink-testing-library';
import {App} from '../../src/ui/app.tsx';
import {LiveStore} from '../../src/ui/liveStore.ts';
import {Store} from '../../src/store/store.ts';
import type {ListName} from '../../src/core/view.ts';
import type {Vault} from './vault.ts';

export const ESC = String.fromCharCode(27);
export const ENTER = '\r';
export const ARROW_DOWN = `${ESC}[B`;
export const ARROW_UP = `${ESC}[A`;

export interface Tui {
  frame(): string;
  /**
   * The task rows on screen: the lines between the rule under the status bar and the
   * hint row at the bottom.
   *
   * Worth having rather than filtering the frame for a task id. Ids no longer appear on
   * rows — only in the hint row, for the selection — so a filter like that silently
   * starts matching the chrome instead of the content, and the test keeps passing while
   * checking nothing.
   */
  rows(): string[];
  /** Whether the app has asked to quit. */
  exited(): boolean;
  /** Send keystrokes, letting React settle after each. */
  press(...keys: string[]): Promise<void>;
  /** Type a string one character at a time, as a person would. */
  type(text: string): Promise<void>;
  live: LiveStore;
  store: Store;
  unmount(): void;
}

export interface TuiOptions {
  now?: string;
  list?: ListName;
}

export function startTui(vault: Vault, options: TuiOptions = {}): Tui {
  const now = options.now ?? '2026-09-12T11:03:00Z';

  let counter = 0;
  const store = new Store(vault.dir, {
    now: () => now,
    // Deterministic but distinct, so ids sort predictably and never collide.
    mint: () => `1nab4${(counter++).toString(32).padStart(7, '0')}`,
  });
  store.ensureLayout();

  const live = new LiveStore(store, {now: () => now});
  let exited = false;
  const instance = render(
    <App
      live={live}
      watching={false}
      initialList={options.list ?? 'next'}
      onExit={() => {
        exited = true;
      }}
    />,
  );

  const settle = async (): Promise<void> => {
    // Two macrotask turns: one for Ink to process the key, one for the re-render that
    // follows the store refresh.
    await new Promise(resolve => setTimeout(resolve, 20));
    await new Promise(resolve => setTimeout(resolve, 20));
  };

  const frame = (): string => instance.lastFrame() ?? '';

  return {
    frame,
    rows: () =>
      frame()
        .split('\n')
        // A task row always begins with the cursor column: the marker, or a space where
        // the marker would be. That excludes the banner, which leads with its own mark,
        // and the hint row, which leads with a key.
        .filter(line => /^[❯ ] \S/.test(line)),
    exited: () => exited,
    async press(...keys: string[]) {
      for (const key of keys) {
        instance.stdin.write(key);
        await settle();
      }
    },
    async type(text: string) {
      for (const character of text) {
        instance.stdin.write(character);
        await new Promise(resolve => setTimeout(resolve, 5));
      }
      await settle();
    },
    live,
    store,
    unmount: () => instance.unmount(),
  };
}
