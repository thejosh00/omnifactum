/**
 * `omni account`: the accounts, their PINs, and the tokens that open them.
 *
 * These run against the database file directly rather than through the server,
 * because they are how you get a token in the first place.
 */
import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
import type {Database} from 'bun:sqlite';
import {parseArgs, hasFlag} from '../core/args.ts';
import {renderJson} from '../core/serialize.ts';
import {createToken, listTokens, revokeToken} from '../db/auth.ts';
import {createAccount, findAccount, listAccounts, setPin} from '../db/database.ts';
import {TOKEN_FILE} from '../client.ts';
import {EXIT_NOT_FOUND, EXIT_OK, EXIT_USAGE} from '../commands/context.ts';

export interface LocalContext {
  db: Database;
  dataDir: string;
  now: () => string;
  json: boolean;
  out: (line?: string) => void;
  err: (line?: string) => void;
}

const USAGE = [
  'usage:',
  '  omni account list                         accounts and tokens',
  '  omni account add <name>                   create another account',
  '  omni account token <account> <actor>      issue a token, e.g. "agent:claude-code"',
  '        [--save]                            and make it this machine\'s default',
  '  omni account revoke <token>               stop a token working',
  '  omni account pin <account> [pin]          set, or with no pin clear, the browser PIN',
].join('\n');

function failWith(ctx: LocalContext, message: string, code: number): number {
  if (ctx.json) ctx.out(renderJson({ok: false, error: message, code}));
  else ctx.err(message);
  return code;
}

export function accountCommand(ctx: LocalContext, argv: readonly string[]): number {
  const args = parseArgs(argv, {boolean: ['save']});
  const [sub, first, second] = args.positional;

  switch (sub) {
    case undefined:
    case 'list': {
      const accounts = listAccounts(ctx.db);
      const tokens = listTokens(ctx.db);
      if (ctx.json) {
        ctx.out(renderJson({accounts: accounts.map(a => ({name: a.name, has_pin: a.hasPin})), tokens}));
        return EXIT_OK;
      }
      ctx.out('accounts:');
      for (const account of accounts) ctx.out(`  ${account.name}${account.hasPin ? '  (PIN)' : ''}`);
      ctx.out('');
      ctx.out(tokens.length === 0 ? 'no tokens yet: omni account token <account> you --save' : 'tokens:');
      for (const token of tokens) ctx.out(`  ${token.account.padEnd(8)}  ${token.actor.padEnd(22)}  ${token.token}`);
      return EXIT_OK;
    }

    case 'add': {
      if (first === undefined) return failWith(ctx, USAGE, EXIT_USAGE);
      const account = createAccount(ctx.db, first);
      if (ctx.json) ctx.out(renderJson({ok: true, account: account.name}));
      else ctx.out(`account ${account.name} is ready`);
      return EXIT_OK;
    }

    case 'token': {
      if (first === undefined || second === undefined) return failWith(ctx, USAGE, EXIT_USAGE);
      const account = findAccount(ctx.db, first);
      if (account === undefined) return failWith(ctx, `no account named "${first}"`, EXIT_NOT_FOUND);
      const token = createToken(ctx.db, account.id, second, ctx.now());
      if (hasFlag(args, 'save')) writeFileSync(join(ctx.dataDir, TOKEN_FILE), `${token}\n`, {mode: 0o600});

      if (ctx.json) {
        ctx.out(renderJson({ok: true, account: account.name, actor: second.trim(), token}));
      } else {
        ctx.out(token);
        ctx.err(
          hasFlag(args, 'save')
            ? `saved as this machine's default; omni now works in "${account.name}" as ${second.trim()}`
            : `use it with: export OMNI_TOKEN=${token}`,
        );
      }
      return EXIT_OK;
    }

    case 'revoke': {
      if (first === undefined) return failWith(ctx, USAGE, EXIT_USAGE);
      if (!revokeToken(ctx.db, first)) return failWith(ctx, 'no such token', EXIT_NOT_FOUND);
      if (ctx.json) ctx.out(renderJson({ok: true}));
      else ctx.out('revoked');
      return EXIT_OK;
    }

    case 'pin': {
      if (first === undefined) return failWith(ctx, USAGE, EXIT_USAGE);
      const account = findAccount(ctx.db, first);
      if (account === undefined) return failWith(ctx, `no account named "${first}"`, EXIT_NOT_FOUND);
      setPin(ctx.db, account.id, second);
      if (ctx.json) ctx.out(renderJson({ok: true}));
      else ctx.out(second === undefined ? `${account.name} no longer asks for a PIN` : `${account.name} now asks for a PIN`);
      return EXIT_OK;
    }

    default:
      return failWith(ctx, USAGE, EXIT_USAGE);
  }
}
