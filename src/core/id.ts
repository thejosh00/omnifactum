/**
 * Task and project identity.
 *
 * A 12-character lowercase Crockford base32 id, shaped like a ULID: 7 characters of
 * Unix seconds followed by 5 random. It sorts lexicographically by creation time, so
 * a plain `ls` is chronological.
 *
 * Twelve rather than a canonical 26 because an agent that has never run `omni` must
 * be able to invent one from a sentence of documentation. Models are poor random
 * generators and emit near-duplicate long strings, and a short id is also typeable at
 * a prompt and readable inside a `project:` link. Collisions are handled where they
 * belong, in `doctor`, which can detect and re-mint them from the files alone.
 *
 * Nothing here reads the clock or generates randomness. Both are parameters, which is
 * what makes every test below an ordinary equality check.
 */

/** Crockford base32: the digits, minus `i`, `l`, `o` and `u`. */
export const ID_ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz';

export const ID_LENGTH = 12;
const TIME_CHARS = 7;
const RANDOM_CHARS = 5;

const RADIX = ID_ALPHABET.length; // 32
const TIME_CAPACITY = RADIX ** TIME_CHARS; // ~3.4e10 seconds, good past the year 3000
const RANDOM_CAPACITY = RADIX ** RANDOM_CHARS; // ~33.5 million

const ID_PATTERN = new RegExp(`^[${ID_ALPHABET}]{${ID_LENGTH}}$`);

function encode(value: number, chars: number): string {
  let out = '';
  let v = Math.floor(value);
  for (let i = 0; i < chars; i++) {
    out = ID_ALPHABET[v % RADIX]! + out;
    v = Math.floor(v / RADIX);
  }
  return out;
}

/**
 * Mint an id. `random` supplies at least 4 bytes of entropy; pass a fixed array in
 * tests for determinism.
 */
export function mintId(nowMs: number, random: Uint8Array): string {
  const seconds = Math.floor(nowMs / 1000);
  if (seconds < 0 || seconds >= TIME_CAPACITY) {
    throw new RangeError(`timestamp ${nowMs} is out of range for a ${ID_LENGTH}-character id`);
  }
  let entropy = 0;
  for (let i = 0; i < 4; i++) {
    entropy = entropy * 256 + (random[i] ?? 0);
  }
  return encode(seconds, TIME_CHARS) + encode(entropy % RANDOM_CAPACITY, RANDOM_CHARS);
}

/** The creation time encoded in an id, or undefined if it is not a valid id. */
export function idTimestampMs(id: string): number | undefined {
  const normalized = normalizeId(id);
  if (normalized === undefined) return undefined;
  let seconds = 0;
  for (const ch of normalized.slice(0, TIME_CHARS)) {
    seconds = seconds * RADIX + ID_ALPHABET.indexOf(ch);
  }
  return seconds * 1000;
}

/**
 * Accept an id the way a human or an agent might have typed it: any case, and with
 * Crockford's ambiguous characters folded (`i` and `l` to `1`, `o` to `0`). Returns
 * undefined if it still is not a valid id.
 */
export function normalizeId(value: string): string | undefined {
  const folded = foldAmbiguous(value);
  return ID_PATTERN.test(folded) ? folded : undefined;
}

export function isValidId(value: string): boolean {
  return normalizeId(value) !== undefined;
}

/** Fold case and Crockford's ambiguous characters. Used for ids and id prefixes. */
export function foldAmbiguous(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[il]/g, '1')
    .replace(/o/g, '0');
}

export type PrefixResolution =
  | {kind: 'ok'; id: string}
  | {kind: 'none'}
  | {kind: 'ambiguous'; candidates: string[]};

/**
 * Resolve a possibly-abbreviated id the way git resolves a short commit hash:
 * unique prefix wins, ambiguity is reported with its candidates.
 */
export function resolveIdPrefix(ids: Iterable<string>, prefix: string): PrefixResolution {
  const needle = foldAmbiguous(prefix);
  if (needle.length === 0) return {kind: 'none'};

  const exact: string[] = [];
  const prefixed: string[] = [];
  for (const id of ids) {
    const folded = foldAmbiguous(id);
    if (folded === needle) exact.push(id);
    else if (folded.startsWith(needle)) prefixed.push(id);
  }

  if (exact.length === 1) return {kind: 'ok', id: exact[0]!};
  if (exact.length > 1) return {kind: 'ambiguous', candidates: exact.sort()};
  if (prefixed.length === 1) return {kind: 'ok', id: prefixed[0]!};
  if (prefixed.length > 1) return {kind: 'ambiguous', candidates: prefixed.sort()};
  return {kind: 'none'};
}
