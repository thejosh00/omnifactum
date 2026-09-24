import {agentsDocument} from '../core/agentsDoc.ts';
import {emit, type Command} from './context.ts';

/** Print the contract for agents. It is generated from the code, so it cannot drift. */
export const agentsCommand: Command = ctx => {
  const text = agentsDocument().trimEnd();
  return emit(ctx, {contract: text}, () => text);
};
