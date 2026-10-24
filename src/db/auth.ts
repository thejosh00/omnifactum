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
import {actorProblem, isActor} from '../core/roles.ts';
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
  if (!isActor(clean)) throw new Error(actorProblem(clean));
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

/**
 * A token issued before actors were checked may name someone who is neither a person
 * nor an agent (`claude`, say). Granting it either role would be a guess, so it is
 * refused, and the refusal says how to replace it.
 */
export class InvalidActorToken extends Error {
  constructor(readonly actor: string, readonly account: string) {
    super(
      `this token's actor "${actor}" is neither "you" nor "agent:<name>", so it is no longer accepted. ` +
        `Re-issue it with "omni account token ${account} agent:<name>" (or "you"), ` +
        `and revoke the old one with "omni account revoke <token>"`,
    );
  }
}

/** The caller a token speaks for; throws `InvalidActorToken` for a token with a bad actor. */
export function callerForToken(db: Database, token: string): Caller | undefined {
  const row = db.query('SELECT account_id, actor FROM tokens WHERE token = ?').get(token) as
    | {account_id: number; actor: string}
    | null;
  if (row === null) return undefined;
  const account = accountById(db, row.account_id);
  if (account === undefined) return undefined;
  if (!isActor(row.actor)) throw new InvalidActorToken(row.actor, account.name);
  return {account, actor: row.actor};
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
