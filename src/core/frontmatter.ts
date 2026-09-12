/**
 * Splitting the `---` fence off the front of a markdown file.
 *
 * The fence is a markdown convention, not part of YAML, so it is handled here by hand
 * rather than being pushed onto the YAML parser. Splitting also records the details
 * that make a byte-identical rejoin possible: a byte-order mark, the line-ending
 * style, and which closing token was used.
 */

export type Eol = '\n' | '\r\n';

export interface SplitFile {
  hasFrontmatter: boolean;
  /** The YAML text between the fences, with no trailing newline. */
  frontmatter: string;
  /** Everything after the closing fence line. */
  body: string;
  hasBom: boolean;
  eol: Eol;
  /** YAML allows `...` as well as `---` to close a document. Preserve whichever was used. */
  closingFence: '---' | '...';
}

const BOM = '﻿';

export function splitFrontmatter(raw: string): SplitFile {
  const hasBom = raw.startsWith(BOM);
  const withoutBom = hasBom ? raw.slice(BOM.length) : raw;
  const eol: Eol = withoutBom.includes('\r\n') ? '\r\n' : '\n';
  const normalized = eol === '\r\n' ? withoutBom.replace(/\r\n/g, '\n') : withoutBom;

  const none: SplitFile = {
    hasFrontmatter: false,
    frontmatter: '',
    body: normalized,
    hasBom,
    eol,
    closingFence: '---',
  };

  const lines = normalized.split('\n');
  if (lines[0] !== '---') return none;

  let closeAt = -1;
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (line === '---' || line === '...') {
      closeAt = i;
      break;
    }
  }
  // An opening fence with no closing one is not frontmatter; treat the whole file as body
  // rather than guessing where the author meant it to end.
  if (closeAt === -1) return none;

  return {
    hasFrontmatter: true,
    frontmatter: lines.slice(1, closeAt).join('\n'),
    body: lines.slice(closeAt + 1).join('\n'),
    hasBom,
    eol,
    closingFence: lines[closeAt] === '...' ? '...' : '---',
  };
}

/**
 * Reverse `splitFrontmatter`. Passing a split straight back through is byte-identical
 * to the input, which is the property the round-trip tests rest on.
 */
export function joinFrontmatter(split: SplitFile): string {
  let out: string;
  if (split.hasFrontmatter) {
    const inner = split.frontmatter.length > 0 ? `${split.frontmatter}\n` : '';
    out = `---\n${inner}${split.closingFence}\n${split.body}`;
  } else {
    out = split.body;
  }

  if (split.eol === '\r\n') out = out.replace(/\n/g, '\r\n');
  return split.hasBom ? BOM + out : out;
}
