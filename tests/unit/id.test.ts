import {describe, expect, test} from 'bun:test';
import {
  ID_ALPHABET,
  ID_LENGTH,
  foldAmbiguous,
  idTimestampMs,
  isValidId,
  mintId,
  normalizeId,
  resolveIdPrefix,
} from '../../src/core/id.ts';

const entropy = (...bytes: number[]) => Uint8Array.from(bytes);

describe('the alphabet', () => {
  test('is 32 unambiguous characters', () => {
    expect(ID_ALPHABET).toHaveLength(32);
    expect(new Set(ID_ALPHABET).size).toBe(32);
  });

  test('excludes the characters that are misread aloud', () => {
    for (const ch of ['i', 'l', 'o', 'u']) {
      expect(ID_ALPHABET).not.toContain(ch);
    }
  });
});

describe('minting', () => {
  test('produces an id of the documented length and shape', () => {
    const id = mintId(Date.UTC(2026, 8, 12, 10, 4, 0), entropy(1, 2, 3, 4));
    expect(id).toHaveLength(ID_LENGTH);
    expect(isValidId(id)).toBe(true);
  });

  test('is deterministic, because time and randomness are arguments', () => {
    const at = Date.UTC(2026, 8, 12, 10, 4, 0);
    expect(mintId(at, entropy(9, 9, 9, 9))).toBe(mintId(at, entropy(9, 9, 9, 9)));
  });

  test('sorts lexicographically by creation time, so `ls` is chronological', () => {
    const early = mintId(Date.UTC(2026, 0, 1), entropy(255, 255, 255, 255));
    const late = mintId(Date.UTC(2026, 8, 12), entropy(0, 0, 0, 0));
    expect(early < late).toBe(true);
  });

  test('ids minted in the same second still differ by entropy', () => {
    const at = Date.UTC(2026, 8, 12, 10, 4, 0);
    expect(mintId(at, entropy(1, 2, 3, 4))).not.toBe(mintId(at, entropy(4, 3, 2, 1)));
  });

  test('round-trips the timestamp to the second', () => {
    const at = Date.UTC(2026, 8, 12, 10, 4, 30);
    expect(idTimestampMs(mintId(at, entropy(1, 1, 1, 1)))).toBe(at);
  });

  test('still has room well past the year 3000', () => {
    const far = Date.UTC(3000, 0, 1);
    expect(() => mintId(far, entropy(1, 1, 1, 1))).not.toThrow();
    expect(mintId(far, entropy(1, 1, 1, 1))).toHaveLength(ID_LENGTH);
  });
});

describe('reading an id a human or an agent typed', () => {
  test('accepts any case', () => {
    expect(normalizeId('0TQ7F2K9ABCD')).toBe('0tq7f2k9abcd');
  });

  test('folds the characters Crockford removed for being ambiguous', () => {
    // The user's original sketch used `01J8F2K9`-style ids, so I and L must read as 1.
    expect(foldAmbiguous('OIL')).toBe('011');
  });

  test('rejects anything that is not an id', () => {
    expect(normalizeId('too-short')).toBeUndefined();
    expect(normalizeId('0tq7f2k9abcdef')).toBeUndefined();
    expect(normalizeId('')).toBeUndefined();
  });
});

describe('prefix resolution, git style', () => {
  const ids = ['0tq7f2k9abcd', '0tq7f2k9zzzz', '0tq8aaaaaaaa'];

  test('a unique prefix resolves', () => {
    expect(resolveIdPrefix(ids, '0tq8')).toEqual({kind: 'ok', id: '0tq8aaaaaaaa'});
  });

  test('an ambiguous prefix reports its candidates instead of guessing', () => {
    const result = resolveIdPrefix(ids, '0tq7');
    expect(result.kind).toBe('ambiguous');
    if (result.kind === 'ambiguous') {
      expect(result.candidates).toEqual(['0tq7f2k9abcd', '0tq7f2k9zzzz']);
    }
  });

  test('an exact id wins over being a prefix of nothing else', () => {
    expect(resolveIdPrefix(ids, '0tq7f2k9abcd')).toEqual({kind: 'ok', id: '0tq7f2k9abcd'});
  });

  test('an unknown prefix resolves to nothing', () => {
    expect(resolveIdPrefix(ids, 'zzzz')).toEqual({kind: 'none'});
  });

  test('an empty prefix never matches everything by accident', () => {
    expect(resolveIdPrefix(ids, '')).toEqual({kind: 'none'});
  });

  test('resolution folds case and ambiguous characters too', () => {
    expect(resolveIdPrefix(['0tq81111aaaa'], '0TQ8IL')).toEqual({kind: 'ok', id: '0tq81111aaaa'});
  });
});
