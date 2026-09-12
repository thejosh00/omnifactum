import {existsSync, readFileSync} from 'node:fs';
import {join} from 'node:path';
import {agentsDocument, CONTRACT_MARKER} from '../core/agentsDoc.ts';
import {CONTRACT_FILE} from '../store/paths.ts';
import {emit, emitOk, type Command} from './context.ts';

/**
 * Create the layout and write the agent contract. Idempotent.
 *
 * If someone has edited `AGENTS.md` by hand, the previous copy is kept rather than
 * silently discarded, and they are pointed at `AGENTS.local.md` for notes of their own.
 */
export const initCommand: Command = ctx => {
  ctx.store.ensureLayout();

  const path = join(ctx.dataDir, CONTRACT_FILE);
  const existing = existsSync(path) ? readFileSync(path, 'utf8') : undefined;
  const handEdited = existing !== undefined && !existing.startsWith(CONTRACT_MARKER);

  if (handEdited) {
    const backup = `${CONTRACT_FILE}.previous`;
    ctx.store.writeDocument(backup, existing);
    if (!ctx.json) {
      ctx.err(`${CONTRACT_FILE} had been edited by hand; the old copy is in ${backup}`);
      ctx.err('put your own notes in AGENTS.local.md, which omni never touches');
    }
  }

  ctx.store.writeDocument(CONTRACT_FILE, agentsDocument());

  return emitOk(
    ctx,
    {data_dir: ctx.dataDir, contract: join(ctx.dataDir, CONTRACT_FILE)},
    () => [
      `omnifactum is ready in ${ctx.dataDir}`,
      `the guide for agents is ${join(ctx.dataDir, CONTRACT_FILE)}`,
    ],
  );
};

/** Print the contract, preferring what is actually on disk since that is what agents read. */
export const agentsCommand: Command = ctx => {
  const path = join(ctx.dataDir, CONTRACT_FILE);
  const text = existsSync(path) ? readFileSync(path, 'utf8').trimEnd() : agentsDocument().trimEnd();
  return emit(ctx, {path, contract: text}, () => text);
};
