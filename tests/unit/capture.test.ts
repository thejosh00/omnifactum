import {describe, expect, test} from 'bun:test';
import {
  applyTagEdit,
  formatTags,
  parseCapture,
  parseTagEdit,
} from '../../src/core/capture.ts';
import {completeLastWord} from '../../src/ui/components/TextInput.tsx';

describe('quick capture', () => {
  test('a plain line is just a title', () => {
    expect(parseCapture('Call the bank')).toEqual({title: 'Call the bank', tags: []});
  });

  test('inline tags are pulled out of the title', () => {
    expect(parseCapture('Call the bank #calls #admin')).toEqual({
      title: 'Call the bank',
      tags: ['calls', 'admin'],
    });
  });

  test('a tag in the middle is pulled out too', () => {
    expect(parseCapture('Call #calls the bank')).toEqual({
      title: 'Call the bank',
      tags: ['calls'],
    });
  });

  test('a project is pulled out', () => {
    expect(parseCapture('Order tiles +kitchen')).toEqual({
      title: 'Order tiles',
      tags: [],
      project: 'kitchen',
    });
  });

  test('tags and a project together', () => {
    expect(parseCapture('Order tiles #home +kitchen')).toEqual({
      title: 'Order tiles',
      tags: ['home'],
      project: 'kitchen',
    });
  });

  test('only the first project counts, since a later + is probably prose', () => {
    expect(parseCapture('Wire A +kitchen to B +bathroom').project).toBe('kitchen');
  });

  test('tags are normalised on the way in', () => {
    expect(parseCapture('Thing #Home #LOW-Energy').tags).toEqual(['home', 'low-energy']);
  });

  test('duplicate tags collapse', () => {
    expect(parseCapture('Thing #home #home').tags).toEqual(['home']);
  });

  test('whitespace left by the extraction is tidied', () => {
    expect(parseCapture('  Call   #calls   the bank  ').title).toBe('Call the bank');
  });

  test('a line of nothing but tags leaves an empty title, which the caller rejects', () => {
    expect(parseCapture('#home #calls').title).toBe('');
  });

  test('a bare # is not a tag', () => {
    expect(parseCapture('Read the # sign').tags).toEqual([]);
  });
});

describe('editing tags', () => {
  test('formatTags shows what a task already has', () => {
    expect(formatTags(['home', 'errand'])).toBe('#home #errand');
    expect(formatTags([])).toBe('');
  });

  test('a list of tags replaces what was there', () => {
    expect(applyTagEdit(['old'], parseTagEdit('home errand'))).toEqual(['home', 'errand']);
  });

  test('the hash is optional', () => {
    expect(applyTagEdit([], parseTagEdit('#home #errand'))).toEqual(['home', 'errand']);
  });

  test('a line of only removals trims the existing list', () => {
    expect(applyTagEdit(['home', 'errand', 'work'], parseTagEdit('-errand'))).toEqual([
      'home',
      'work',
    ]);
  });

  test('removals apply to the replacement list too', () => {
    expect(applyTagEdit(['old'], parseTagEdit('home errand -errand'))).toEqual(['home']);
  });

  test('an empty line clears nothing, rather than clearing everything by accident', () => {
    expect(applyTagEdit(['home'], parseTagEdit('   '))).toEqual(['home']);
  });

  test('unusable tags are dropped rather than written', () => {
    expect(applyTagEdit([], parseTagEdit('home a,b'))).toEqual(['home']);
  });
});

describe('tab completion in the filter bar', () => {
  const tags = ['home', 'homework', 'work'];

  test('a unique match completes and adds a space', () => {
    expect(completeLastWord('wo', tags)).toBe('work ');
  });

  test('several matches complete as far as they agree', () => {
    expect(completeLastWord('ho', tags)).toBe('home');
  });

  test('it completes only the last word', () => {
    expect(completeLastWord('home wo', tags)).toBe('home work ');
  });

  test('no match changes nothing', () => {
    expect(completeLastWord('zzz', tags)).toBeUndefined();
  });

  test('nothing to complete from changes nothing', () => {
    expect(completeLastWord('ho', [])).toBeUndefined();
  });

  test('an already-complete word is left alone rather than looping', () => {
    expect(completeLastWord('home', ['home', 'homework'])).toBeUndefined();
  });
});
