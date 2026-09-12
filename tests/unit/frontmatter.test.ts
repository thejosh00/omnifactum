import {describe, expect, test} from 'bun:test';
import {joinFrontmatter, splitFrontmatter} from '../../src/core/frontmatter.ts';

const BOM = '﻿';

/** The property everything else rests on: split then join changes nothing. */
function expectByteStable(raw: string): void {
  expect(joinFrontmatter(splitFrontmatter(raw))).toBe(raw);
}

describe('splitting the fence', () => {
  test('separates frontmatter from body', () => {
    const raw = '---\nid: 0tq7f2k9abcd\ntitle: Fix printer\n---\n\nThe body.\n';
    const split = splitFrontmatter(raw);
    expect(split.hasFrontmatter).toBe(true);
    expect(split.frontmatter).toBe('id: 0tq7f2k9abcd\ntitle: Fix printer');
    expect(split.body).toBe('\nThe body.\n');
  });

  test('a file with no frontmatter is all body, which is still a valid task', () => {
    const raw = 'Just a note an agent dropped in.\n';
    const split = splitFrontmatter(raw);
    expect(split.hasFrontmatter).toBe(false);
    expect(split.body).toBe(raw);
  });

  test('an unclosed fence is not treated as frontmatter', () => {
    const raw = '---\nid: 0tq7f2k9abcd\n\nno closing fence\n';
    expect(splitFrontmatter(raw).hasFrontmatter).toBe(false);
  });

  test('a `...` close is recognised and remembered', () => {
    const split = splitFrontmatter('---\nid: x\n...\nbody\n');
    expect(split.hasFrontmatter).toBe(true);
    expect(split.closingFence).toBe('...');
  });

  test('empty frontmatter is still frontmatter', () => {
    const split = splitFrontmatter('---\n---\nbody\n');
    expect(split.hasFrontmatter).toBe(true);
    expect(split.frontmatter).toBe('');
  });

  test('a `---` inside the body does not confuse the split', () => {
    const raw = '---\nid: x\n---\n\nSome prose.\n\n---\n\nMore prose.\n';
    const split = splitFrontmatter(raw);
    expect(split.frontmatter).toBe('id: x');
    expect(split.body).toContain('More prose.');
  });
});

describe('recording what makes a rejoin exact', () => {
  test('notices a byte-order mark', () => {
    expect(splitFrontmatter(`${BOM}---\nid: x\n---\nbody\n`).hasBom).toBe(true);
    expect(splitFrontmatter('---\nid: x\n---\nbody\n').hasBom).toBe(false);
  });

  test('notices CRLF line endings', () => {
    expect(splitFrontmatter('---\r\nid: x\r\n---\r\nbody\r\n').eol).toBe('\r\n');
    expect(splitFrontmatter('---\nid: x\n---\nbody\n').eol).toBe('\n');
  });

  test('parses CRLF content as if it were LF', () => {
    expect(splitFrontmatter('---\r\nid: x\r\n---\r\nbody\r\n').frontmatter).toBe('id: x');
  });
});

describe('round-tripping is byte-identical', () => {
  const cases: Record<string, string> = {
    'a plain task': '---\nid: 0tq7f2k9abcd\ntitle: Fix printer\n---\n\nBody text.\n',
    'no trailing newline': '---\nid: x\n---\nbody',
    'no frontmatter at all': 'just prose\n',
    'empty frontmatter': '---\n---\nbody\n',
    'a byte-order mark': `${BOM}---\nid: x\n---\nbody\n`,
    'CRLF throughout': '---\r\nid: x\r\n---\r\n\r\nbody\r\n',
    'a `...` close': '---\nid: x\n...\nbody\n',
    'comments and blank lines in the frontmatter':
      '---\n# a human wrote this\nid: x\n\ntitle: y\n---\nbody\n',
    'an entirely empty file': '',
    'body with several blank lines': '---\nid: x\n---\n\n\n\nbody\n\n\n',
  };

  for (const [name, raw] of Object.entries(cases)) {
    test(name, () => {
      expectByteStable(raw);
    });
  }
});
