import {describe, expect, test} from 'bun:test';
import {
  MAX_STEM_LENGTH,
  foldName,
  isAppAuthoredStem,
  slugify,
  stemFor,
  uniqueStem,
} from '../../src/core/slug.ts';

describe('slugify', () => {
  test('produces the clean filename from the approved example', () => {
    expect(slugify('Fix printer driver')).toBe('fix-printer-driver');
  });

  test('drops apostrophes rather than splitting the word', () => {
    expect(slugify("Don't forget the milk")).toBe('dont-forget-the-milk');
    expect(slugify('Don’t forget')).toBe('dont-forget');
  });

  test('collapses runs of punctuation into a single separator', () => {
    expect(slugify('Call Bob re: budget -- urgent!!')).toBe('call-bob-re-budget-urgent');
  });

  test('never leaves a leading or trailing separator', () => {
    expect(slugify('  ...hello...  ')).toBe('hello');
  });

  test('keeps non-Latin letters rather than throwing the title away', () => {
    expect(slugify('café meeting')).toBe('café-meeting');
    expect(slugify('会議の準備')).toBe('会議の準備');
  });

  test('caps the length and does not end mid-separator', () => {
    const long = 'a'.repeat(80);
    expect(slugify(long)).toHaveLength(MAX_STEM_LENGTH);
    const wordy = `${'b'.repeat(59)} tail`;
    expect(slugify(wordy).endsWith('-')).toBe(false);
  });

  test('returns empty for a title with no usable characters', () => {
    expect(slugify('!!!')).toBe('');
    expect(slugify('🎉🎉')).toBe('');
  });
});

describe('stemFor', () => {
  test('falls back to the id when a title slugs to nothing', () => {
    expect(stemFor('🎉', '0tq7f2k9abcd')).toBe('0tq7f2k9abcd');
  });

  test('uses the slug when there is one', () => {
    expect(stemFor('Fix printer', '0tq7f2k9abcd')).toBe('fix-printer');
  });
});

describe('foldName, the macOS guard', () => {
  test('folds case, because APFS is case-insensitive', () => {
    expect(foldName('Fix-Printer')).toBe(foldName('fix-printer'));
  });

  test('folds Unicode form, because readdir returns NFD and literals are NFC', () => {
    const composed = 'café'; // é as one code point, what a title gives us
    const decomposed = 'café'; // e + combining accent, what readdir gives us
    expect(composed).not.toBe(decomposed);
    expect(foldName(composed)).toBe(foldName(decomposed));
  });
});

describe('uniqueStem', () => {
  test('leaves a free name alone', () => {
    expect(uniqueStem('fix-printer', ['other'])).toBe('fix-printer');
  });

  test('suffixes on collision', () => {
    expect(uniqueStem('fix-printer', ['fix-printer'])).toBe('fix-printer-2');
    expect(uniqueStem('fix-printer', ['fix-printer', 'fix-printer-2'])).toBe('fix-printer-3');
  });

  test('treats a differently-cased name as a collision', () => {
    expect(uniqueStem('fix-printer', ['Fix-Printer'])).toBe('fix-printer-2');
  });

  test('treats a differently-normalised name as a collision', () => {
    expect(uniqueStem('café', ['café'])).toBe('café-2');
  });

  test('stays within the length cap even after suffixing', () => {
    const long = 'a'.repeat(MAX_STEM_LENGTH);
    const result = uniqueStem(long, [long]);
    expect(result.length).toBeLessThanOrEqual(MAX_STEM_LENGTH);
    expect(result.endsWith('-2')).toBe(true);
  });
});

describe('isAppAuthoredStem, the rule that stops the app fighting the user', () => {
  const id = '0tq7f2k9abcd';

  test('recognises a name it generated', () => {
    expect(isAppAuthoredStem('fix-printer', 'Fix printer', id)).toBe(true);
  });

  test('recognises a name it generated with a collision suffix', () => {
    expect(isAppAuthoredStem('fix-printer-2', 'Fix printer', id)).toBe(true);
  });

  test('leaves a name a human chose alone', () => {
    expect(isAppAuthoredStem('URGENT-printer-thing', 'Fix printer', id)).toBe(false);
  });

  test('recognises the id fallback as its own', () => {
    expect(isAppAuthoredStem(id, '🎉', id)).toBe(true);
  });
});
