import {describe, expect, test} from 'bun:test';
import {
  appendLogEntry,
  formatLogEntry,
  joinBodyAndLog,
  latestEntry,
  splitBodyAndLog,
} from '../../src/core/log.ts';

describe('splitting prose from the log', () => {
  test('finds the section and keeps the prose intact', () => {
    const body = '\nDriver crashes.\n\n## Log\n\n- 2026-09-12T11:03:00Z **you** — Called vendor.\n';
    const split = splitBodyAndLog(body);
    expect(split.hasLogSection).toBe(true);
    expect(split.body).toBe('\nDriver crashes.\n');
    expect(split.log).toHaveLength(1);
    expect(split.log[0]?.actor).toBe('you');
    expect(split.log[0]?.text).toBe('Called vendor.');
  });

  test('a file with no log section is all prose', () => {
    const split = splitBodyAndLog('\nJust notes.\n');
    expect(split.hasLogSection).toBe(false);
    expect(split.log).toEqual([]);
  });

  test('the last Log heading wins, since the section is defined as final', () => {
    const body = '## Log\n\n- 2026-01-01T00:00:00Z **you** — decoy in the prose\n\n## Log\n\n- 2026-09-12T11:03:00Z **omni** — real\n';
    const split = splitBodyAndLog(body);
    expect(split.log).toHaveLength(1);
    expect(split.log[0]?.text).toBe('real');
  });

  test('the heading is matched case-insensitively and at any level', () => {
    expect(splitBodyAndLog('### log\n\n- 2026-09-12T11:03:00Z x\n').hasLogSection).toBe(true);
  });
});

describe('parsing entries an agent or a human might write', () => {
  const parse = (line: string) => splitBodyAndLog(`## Log\n\n${line}\n`).log[0];

  test('the full form', () => {
    const entry = parse('- 2026-09-12T11:03:00Z **agent:claude-code** — Installed PPD 4.2.');
    expect(entry).toMatchObject({
      at: '2026-09-12T11:03:00Z',
      actor: 'agent:claude-code',
      text: 'Installed PPD 4.2.',
      parsed: true,
    });
  });

  test('an entry with no actor', () => {
    expect(parse('- 2026-09-12T11:03:00Z — did the thing')).toMatchObject({
      actor: '',
      text: 'did the thing',
      parsed: true,
    });
  });

  test('an entry with no dash, which is what a shell append most easily produces', () => {
    expect(parse('- 2026-09-12T11:03:00Z **you** did the thing')).toMatchObject({
      actor: 'you',
      text: 'did the thing',
      parsed: true,
    });
  });

  test('a plain hyphen instead of an em dash', () => {
    expect(parse('- 2026-09-12T11:03:00Z **you** - did it')).toMatchObject({text: 'did it'});
  });

  test('an asterisk bullet', () => {
    expect(parse('* 2026-09-12T11:03:00Z **you** — did it')).toMatchObject({parsed: true});
  });

  test('a timestamp without seconds', () => {
    expect(parse('- 2026-09-12T11:03Z **you** — did it')).toMatchObject({parsed: true});
  });

  test('a line that is not an entry is kept verbatim rather than discarded', () => {
    const entry = parse('some freeform note under the heading');
    expect(entry?.parsed).toBe(false);
    expect(entry?.raw).toBe('some freeform note under the heading');
  });

  test('blank lines are ignored', () => {
    expect(splitBodyAndLog('## Log\n\n\n\n').log).toEqual([]);
  });
});

describe('formatting', () => {
  test('writes the documented shape', () => {
    expect(formatLogEntry('2026-09-12T11:03:00Z', 'omni', 'Promoted from someday.')).toBe(
      '- 2026-09-12T11:03:00Z **omni** — Promoted from someday.',
    );
  });

  test('omits the actor when there is not one', () => {
    expect(formatLogEntry('2026-09-12T11:03:00Z', '', 'did it')).toBe(
      '- 2026-09-12T11:03:00Z — did it',
    );
  });

  test('collapses a multi-line note so one entry stays one line', () => {
    expect(formatLogEntry('2026-09-12T11:03:00Z', 'you', 'first\n  second')).toContain(
      'first second',
    );
  });
});

describe('rejoining', () => {
  test('puts the log last, which is what makes a shell append safe', () => {
    const out = joinBodyAndLog('\nProse here.\n', [
      {at: '2026-09-12T11:03:00Z', actor: 'you', text: 'did it', raw: '', parsed: true},
    ]);
    expect(out.indexOf('## Log')).toBeGreaterThan(out.indexOf('Prose here.'));
    expect(out.trimEnd().endsWith('did it')).toBe(true);
  });

  test('writes no heading when there are no entries', () => {
    expect(joinBodyAndLog('\nProse.\n', [])).not.toContain('## Log');
  });

  test('an unparsed line is written back exactly as it came in', () => {
    const out = joinBodyAndLog('', [
      {at: '', actor: '', text: 'x', raw: '  odd line, left alone', parsed: false},
    ]);
    expect(out).toContain('  odd line, left alone');
  });

  test('survives a full split and rejoin', () => {
    const body = '\nDriver crashes.\n\n## Log\n\n- 2026-09-12T11:03:00Z **you** — Called vendor.\n';
    const split = splitBodyAndLog(body);
    expect(joinBodyAndLog(split.body, split.log)).toBe(body);
  });
});

describe('appending', () => {
  test('adds to the end, keeping the list oldest first', () => {
    const first = appendLogEntry([], '2026-09-12T10:00:00Z', 'you', 'first');
    const second = appendLogEntry(first, '2026-09-12T11:00:00Z', 'omni', 'second');
    expect(second.map(e => e.text)).toEqual(['first', 'second']);
  });

  test('latestEntry names who last acted, so the UI can say who completed a task', () => {
    const log = appendLogEntry(
      appendLogEntry([], '2026-09-12T10:00:00Z', 'you', 'first'),
      '2026-09-12T11:00:00Z',
      'agent:claude-code',
      'Installed PPD 4.2.',
    );
    expect(latestEntry(log)?.actor).toBe('agent:claude-code');
  });

  test('latestEntry skips lines that did not parse', () => {
    const log = [
      {at: '2026-09-12T10:00:00Z', actor: 'you', text: 'real', raw: '', parsed: true},
      {at: '', actor: '', text: '', raw: 'noise', parsed: false},
    ];
    expect(latestEntry(log)?.text).toBe('real');
  });
});
