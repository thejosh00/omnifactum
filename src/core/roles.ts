/**
 * Who may do what: a person (`you`) or an agent (`agent:<name>`).
 *
 * Every write — each non-GET API route and each command the server runs for the CLI —
 * declares the roles allowed to make it. Anything without a declaration is refused for
 * everyone, so a new route or command is closed until someone decides who it is for.
 *
 * What an agent may do is what `skills/omni-work/SKILL.md` has it do: read anything, add
 * tasks, add notes, change tags, submit work for review, and move tasks between states
 * other than `done`. Finishing, deleting, overriding a guard with `force`, recording the
 * weekly review and the tickler's writes are the person's.
 */
import {ACTOR_USER} from './mutation.ts';

export type Role = 'you' | 'agent';

export const BOTH: readonly Role[] = ['you', 'agent'];
export const YOU_ONLY: readonly Role[] = ['you'];

const ACTOR_PATTERN = /^(you|agent:[a-z0-9][a-z0-9_-]{0,39})$/;

/** `you`, or `agent:<name>` (lowercase letters, digits, - and _). */
export const isActor = (value: string): boolean => ACTOR_PATTERN.test(value);

export function actorProblem(actor: string): string {
  return `an actor is "you" or "agent:<name>" (lowercase letters, digits, - and _), not "${actor}"`;
}

/** The role an actor plays. Anything that is not a valid actor plays none. */
export function roleOf(actor: string): Role | undefined {
  if (!isActor(actor)) return undefined;
  return actor === ACTOR_USER ? 'you' : 'agent';
}

/**
 * The refusal, worded once for the route and the command. `allow` undefined means the
 * write was never declared, so it is nobody's.
 */
export function refusalMessage(what: string, allow: readonly Role[] | undefined): string {
  if (allow === undefined || allow.length === 0) return `${what} is not open to anyone: it has no role declaration`;
  return `${what} is the person's call, not an agent's`;
}
