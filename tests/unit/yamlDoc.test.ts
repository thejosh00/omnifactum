import {describe, expect, test} from 'bun:test';
import {FrontmatterDoc} from '../../src/core/yamlDoc.ts';

describe('reading', () => {
  test('reads the fields of a typical task', () => {
    const doc = FrontmatterDoc.parse(
      'id: 0tq7f2k9abcd\ntitle: Fix printer driver\ncreated: 2026-09-12T10:04:00Z',
    );
    expect(doc.ok).toBe(true);
    expect(doc.getString('id')).toBe('0tq7f2k9abcd');
    expect(doc.getString('title')).toBe('Fix printer driver');
  });

  test('a missing field reads as undefined, not as an error', () => {
    const doc = FrontmatterDoc.parse('id: x');
    expect(doc.getString('due')).toBeUndefined();
  });

  test('an empty field reads as undefined', () => {
    const doc = FrontmatterDoc.parse('id: x\ntitle:   ');
    expect(doc.getString('title')).toBeUndefined();
  });

  test('lists the keys present, so unknown ones can be reported', () => {
    const doc = FrontmatterDoc.parse('id: x\ntitle: y\nmystery: z');
    expect(doc.keys()).toEqual(['id', 'title', 'mystery']);
  });
});

describe('the YAML 1.2 coercion guard', () => {
  test('a tag that looks like a number stays the text that was written', () => {
    const doc = FrontmatterDoc.parse('tags: [2026, home]');
    const tags = doc.getTags('tags');
    expect(tags.values).toEqual(['2026', 'home']);
    expect(tags.coerced).toEqual(['2026']);
  });

  test('a tag that looks like a boolean stays text', () => {
    const doc = FrontmatterDoc.parse('tags: [true, false, home]');
    expect(doc.getTags('tags').values).toEqual(['true', 'false', 'home']);
  });

  test('a quoted tag loses its quotes and not its meaning', () => {
    const doc = FrontmatterDoc.parse('tags: ["on-hold", home]');
    const tags = doc.getTags('tags');
    expect(tags.values).toEqual(['on-hold', 'home']);
    expect(tags.coerced).toEqual([]);
  });

  test('a time-like due date is not turned into a number', () => {
    const doc = FrontmatterDoc.parse('due: 10:30');
    expect(doc.getString('due')).toBe('10:30');
  });
});

describe('reading tags people actually write', () => {
  test('accepts a block sequence', () => {
    const doc = FrontmatterDoc.parse('tags:\n  - home\n  - errand');
    expect(doc.getTags('tags').values).toEqual(['home', 'errand']);
  });

  test('accepts a flow sequence', () => {
    expect(FrontmatterDoc.parse('tags: [home, errand]').getTags('tags').values).toEqual([
      'home',
      'errand',
    ]);
  });

  test('accepts a bare string as a one-tag list', () => {
    expect(FrontmatterDoc.parse('tags: home').getTags('tags').values).toEqual(['home']);
  });

  test('a missing tags key is an empty list', () => {
    expect(FrontmatterDoc.parse('id: x').getTags('tags').values).toEqual([]);
  });

  test('a trailing comma leaves no phantom empty tag', () => {
    expect(FrontmatterDoc.parse('tags: [home, ]').getTags('tags').values).toEqual(['home']);
  });
});

describe('damaged frontmatter', () => {
  // A human writing `title: Call Bob re: budget` produces genuinely invalid YAML.
  // It must be detected rather than silently misread, and never rewritten.
  const damaged = 'title: Call Bob re: budget\nid: x';

  test('is reported rather than thrown', () => {
    const doc = FrontmatterDoc.parse(damaged);
    expect(doc.ok).toBe(false);
    expect(doc.errors.length).toBeGreaterThan(0);
  });

  test('refuses to be serialised once modified, so it cannot be corrupted further', () => {
    const doc = FrontmatterDoc.parse(damaged);
    doc.set('title', 'something new');
    expect(() => doc.toText()).toThrow(/refusing to serialise/);
  });
});

describe('an empty document, which is what a bare agent-written file needs', () => {
  test('starts with no fields and is ok', () => {
    const doc = FrontmatterDoc.empty();
    expect(doc.ok).toBe(true);
    expect(doc.keys()).toEqual([]);
  });

  test('renders as ordinary block frontmatter once fields are set', () => {
    const doc = FrontmatterDoc.empty();
    doc.set('id', '0tq7f2k9abcd');
    doc.set('title', 'Dropped in by an agent');
    doc.set('created', '2026-09-12T10:04:00Z');
    const out = doc.toText();
    expect(out).toBe(
      'id: 0tq7f2k9abcd\ntitle: Dropped in by an agent\ncreated: 2026-09-12T10:04:00Z',
    );
    expect(FrontmatterDoc.parse(out).ok).toBe(true);
  });

  test('round-trips tags as a flow sequence', () => {
    const doc = FrontmatterDoc.empty();
    doc.set('id', 'x');
    doc.setTags('tags', ['home', 'agent']);
    expect(FrontmatterDoc.parse(doc.toText()).getTags('tags').values).toEqual(['home', 'agent']);
  });
});

describe('writing', () => {
  test('an untouched document returns its original bytes exactly', () => {
    // Serialising normalises whitespace the author may have chosen on purpose — two
    // spaces before a trailing comment become one — so an unchanged file must never
    // be round-tripped through the library at all.
    const original = 'id: x\ntags: [home, errand]\nwaiting_on: Acme  # chased 3 times';
    const doc = FrontmatterDoc.parse(original);
    expect(doc.changed).toBe(false);
    expect(doc.toText()).toBe(original);
  });

  test('setting a field to its current value is not a change', () => {
    const doc = FrontmatterDoc.parse('id: x\ntitle: Fix printer');
    doc.set('title', 'Fix printer');
    expect(doc.changed).toBe(false);
  });

  test('setting a new value marks the document changed and updates it', () => {
    const doc = FrontmatterDoc.parse('id: x\ntitle: Fix printer');
    doc.set('title', 'Fix the printer');
    expect(doc.changed).toBe(true);
    expect(doc.toText()).toContain('title: Fix the printer');
  });

  test('a comment and key order survive an edit', () => {
    const doc = FrontmatterDoc.parse('# mine\nid: x\ntitle: old\nwaiting_on: Acme # chased');
    doc.set('title', 'new');
    const out = doc.toText();
    expect(out).toContain('# mine');
    expect(out).toContain('# chased');
    expect(doc.keys()).toEqual(['id', 'title', 'waiting_on']);
  });

  test('a field the app knows nothing about survives an edit', () => {
    const doc = FrontmatterDoc.parse('id: x\nenergy: low\ntitle: old');
    doc.set('title', 'new');
    expect(doc.toText()).toContain('energy: low');
  });

  test('a title containing a colon is quoted, so the file stays valid YAML', () => {
    const doc = FrontmatterDoc.parse('id: x');
    doc.set('title', 'Call Bob re: budget');
    const out = doc.toText();
    expect(FrontmatterDoc.parse(out).ok).toBe(true);
    expect(FrontmatterDoc.parse(out).getString('title')).toBe('Call Bob re: budget');
  });

  test('setting a field to undefined removes it, keeping typical files short', () => {
    const doc = FrontmatterDoc.parse('id: x\ndue: 2026-10-15');
    doc.set('due', undefined);
    expect(doc.toText()).not.toContain('due');
  });

  test('tags are written as a flow sequence, on one line', () => {
    const doc = FrontmatterDoc.parse('id: x');
    doc.setTags('tags', ['home', 'errand']);
    expect(doc.toText()).toContain('tags: [home, errand]');
  });

  test('a tag that looks like a number is quoted so it reads back as a string', () => {
    const doc = FrontmatterDoc.parse('id: x');
    doc.setTags('tags', ['2026', 'home']);
    const reread = FrontmatterDoc.parse(doc.toText()).getTags('tags');
    expect(reread.values).toEqual(['2026', 'home']);
    expect(reread.coerced).toEqual([]);
  });

  test('an empty tag list removes the key rather than writing an empty array', () => {
    const doc = FrontmatterDoc.parse('id: x\ntags: [home]');
    doc.setTags('tags', []);
    expect(doc.toText()).not.toContain('tags');
  });

  test('setting tags to what they already are is not a change', () => {
    const doc = FrontmatterDoc.parse('id: x\ntags: [home, errand]');
    doc.setTags('tags', ['home', 'errand']);
    expect(doc.changed).toBe(false);
  });
});
