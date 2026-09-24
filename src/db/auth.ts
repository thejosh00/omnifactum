/**
 * Who is calling, and which account they are working in.
 *
 * This runs on a home network and security was explicitly not the goal, so this is
 * about keeping two lists apart and recording who did what — not about keeping anyone
 * out. A token names an account and an actor. The CLI and agents send one; a browser
 * gets a session cookie after picking an account.
 */
import {randomBytes} from 'node:crypto';
import type {Database} from 'bun:sqlite';
import {ACTOR_USER} from '../core/mutation.ts';
import {listAccounts, type Account} from './database.ts';

export interface Caller {
  account: Account;
  /** `you` for a person, `agent:<name>` for an agent. */
  actor: string;
}

function secret(): string {
  return randomBytes(24).toString('base64url');
}

function accountById(db: Database, id: number): Account | undefined {
  return listAccounts(db).find(account => account.id === id);
}

/** Issue a token for an account. The actor is fixed for the token's lifetime. */
export function createToken(db: Database, accountId: number, actor: string, now: string): string {
  const clean = actor.trim();
  if (clean.length === 0) throw new Error('a token needs an actor, such as "you" or "agent:claude-code"');
  const token = `omni_${secret()}`;
  db.query('INSERT INTO tokens (token, account_id, actor, created) VALUES (?, ?, ?, ?)').run(
    token,
    accountId,
    clean,
    now,
  );
  return token;
}

export interface TokenInfo {
  token: string;
  account: string;
  actor: string;
  created: string;
}

export function listTokens(db: Database): TokenInfo[] {
  return db
    .query(
      `SELECT tokens.token, accounts.name AS account, tokens.actor, tokens.created
       FROM tokens JOIN accounts ON accounts.id = tokens.account_id ORDER BY tokens.created`,
    )
    .all() as TokenInfo[];
}

export function revokeToken(db: Database, token: string): boolean {
  return db.query('DELETE FROM tokens WHERE token = ?').run(token).changes > 0;
}

export function callerForToken(db: Database, token: string): Caller | undefined {
  const row = db.query('SELECT account_id, actor FROM tokens WHERE token = ?').get(token) as
    | {account_id: number; actor: string}
    | null;
  if (row === null) return undefined;
  const account = accountById(db, row.account_id);
  return account === undefined ? undefined : {account, actor: row.actor};
}

export function createSession(db: Database, accountId: number, now: string): string {
  const id = secret();
  db.query('INSERT INTO sessions (id, account_id, created) VALUES (?, ?, ?)').run(id, accountId, now);
  return id;
}

export function endSession(db: Database, id: string): void {
  db.query('DELETE FROM sessions WHERE id = ?').run(id);
}

export function callerForSession(db: Database, id: string): Caller | undefined {
  const row = db.query('SELECT account_id FROM sessions WHERE id = ?').get(id) as
    | {account_id: number}
    | null;
  if (row === null) return undefined;
  const account = accountById(db, row.account_id);
  // A person in a browser is always "you".
  return account === undefined ? undefined : {account, actor: ACTOR_USER};
}
