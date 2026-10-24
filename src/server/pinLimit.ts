/**
 * Slowing down PIN guessing (R2).
 *
 * A PIN is a few digits, so without a limit anyone who can reach the port could try
 * them all in minutes. Each remote address gets `limit` wrong PINs per `windowMs`; after
 * that, sign-in from that address is refused with 429 until the oldest failure ages out.
 * A right PIN does not reset the count — it only stops adding to it. Applies whatever
 * the bind, since a web page can reach loopback too.
 *
 * In memory: a restart forgets, which is fine for slowing a guesser down.
 */
export const PIN_ATTEMPTS = 5;
export const PIN_WINDOW_MS = 60_000;

export class PinLimiter {
  private readonly failures = new Map<string, number[]>();

  constructor(
    private readonly limit = PIN_ATTEMPTS,
    private readonly windowMs = PIN_WINDOW_MS,
    private readonly clock: () => number = Date.now,
  ) {}

  private recent(address: string): number[] {
    const cutoff = this.clock() - this.windowMs;
    const kept = (this.failures.get(address) ?? []).filter(at => at > cutoff);
    if (kept.length === 0) this.failures.delete(address);
    else this.failures.set(address, kept);
    return kept;
  }

  /** Seconds until this address may try again, or undefined if it may try now. */
  blocked(address: string): number | undefined {
    const recent = this.recent(address);
    if (recent.length < this.limit) return undefined;
    return Math.max(1, Math.ceil((recent[0]! + this.windowMs - this.clock()) / 1000));
  }

  fail(address: string): void {
    this.failures.set(address, [...this.recent(address), this.clock()]);
  }
}
