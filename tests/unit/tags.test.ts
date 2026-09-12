import {describe, expect, test} from 'bun:test';
import {
  completeTag,
  isValidTag,
  normalizeTag,
  normalizeTags,
  tagIndex,
} from '../../src/core/tags.ts';

describe('normalizeTag', () => {
  test('lowercases and trims', () => {
    expect(normalizeTag('  Home  ')).toBe('home');
  });

  test('accepts a leading hash, since that is how people write tags', () => {
    expect(normalizeTag('#home')).toBe('home');
  });

  test('turns spaces into separators', () => {
    expect(normalizeTag('low energy')).toBe('low-energy');
  });

  test('keeps a slash, so a hierarchy is writable today', () => {
    expect(normalizeTag('work/acme')).toBe('work/acme');
  });

  test('strips stray separators at the edges', () => {
    expect(normalizeTag('--home--')).toBe('home');
  });
});

describe('isValidTag', () => {
  test('accepts ordinary tags', () => {
    for (const tag of ['home', 'work/acme', 'low-energy', 'v2.0', 'p1']) {
      expect(isValidTag(tag)).toBe(true);
    }
  });

  test('rejects tags that would not survive a round trip', () => {
    for (const tag of ['', '-home', 'Home', 'two words', 'a,b']) {
      expect(isValidTag(tag)).toBe(false);
    }
  });
});

describe('normalizeTags', () => {
  test('normalises, deduplicates, and keeps the author ordering', () => {
    const result = normalizeTags(['Errand', '#home', 'errand', 'HOME']);
    expect(result.tags).toEqual(['errand', 'home']);
  });

  test('reports what it could not use rather than dropping it silently', () => {
    const result = normalizeTags(['home', 'a,b']);
    expect(result.tags).toEqual(['home']);
    expect(result.invalid).toEqual(['a,b']);
  });

  test('ignores empty entries', () => {
    expect(normalizeTags(['home', '   ', '']).tags).toEqual(['home']);
  });

  test('a numeric tag survives as text', () => {
    expect(normalizeTags(['2026']).tags).toEqual(['2026']);
  });
});

describe('the tag index, which is built from usage and never registered', () => {
  const tasks = [
    {tags: ['home', 'errand'], created: '2026-09-01T00:00:00Z'},
    {tags: ['home', 'agent'], created: '2026-09-10T00:00:00Z'},
    {tags: ['home'], created: '2026-09-12T00:00:00Z'},
    {tags: ['work'], created: '2026-08-01T00:00:00Z'},
  ];

  test('counts uses and orders by how common a tag is', () => {
    const index = tagIndex(tasks);
    expect(index[0]).toMatchObject({tag: 'home', count: 3});
    expect(index.map(u => u.tag)).toEqual(['home', 'agent', 'errand', 'work']);
  });

  test('remembers the most recent use, for breaking ties', () => {
    expect(tagIndex(tasks).find(u => u.tag === 'home')?.lastUsed).toBe('2026-09-12T00:00:00Z');
  });

  test('a tag that stops being used simply stops existing', () => {
    expect(tagIndex([]).map(u => u.tag)).toEqual([]);
  });
});

describe('autocomplete ranking', () => {
  const index = tagIndex([
    {tags: ['home'], created: '2026-09-12T00:00:00Z'},
    {tags: ['home'], created: '2026-09-11T00:00:00Z'},
    {tags: ['homework'], created: '2026-09-10T00:00:00Z'},
    {tags: ['at-home'], created: '2026-09-09T00:00:00Z'},
    {tags: ['work'], created: '2026-09-08T00:00:00Z'},
  ]);

  test('prefix matches come before substring matches', () => {
    expect(completeTag(index, 'home')).toEqual(['home', 'homework', 'at-home']);
  });

  test('among prefix matches, the more-used tag wins', () => {
    expect(completeTag(index, 'hom')[0]).toBe('home');
  });

  test('an empty input offers every distinct tag', () => {
    expect(completeTag(index, '')).toEqual(['home', 'at-home', 'homework', 'work']);
  });

  test('no match offers nothing rather than everything', () => {
    expect(completeTag(index, 'zzz')).toEqual([]);
  });

  test('completion normalises what was typed, so a hash still matches', () => {
    expect(completeTag(index, '#hom')[0]).toBe('home');
  });
});
