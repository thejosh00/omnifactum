import {describe, expect, test} from 'bun:test';
import {
  applyTagEdit,
  formatTags,
  parseCapture,
  completeLastWord,
  completing,
  parseTagEdit,
} from '../../src/core/capture.ts';

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

describe('capturing straight into a list, with dates', () => {
  // A Wednesday, 9am in Chicago (the suite's time zone).
  const WEDNESDAY = '2026-09-23T14:00:00Z';

  test('a list, a due date and tags come out of the line; the rest is the title', () => {
    expect(parseCapture('Call the bank #calls >next due:fri', WEDNESDAY)).toEqual({
      title: 'Call the bank',
      tags: ['calls'],
      state: 'next',
      due: '2026-09-25',
    });
  });

  test('a weekday is the next one after today, never today itself', () => {
    expect(parseCapture('x due:wed', WEDNESDAY).due).toBe('2026-09-30');
    expect(parseCapture('x due:thursday', WEDNESDAY).due).toBe('2026-09-24');
    expect(parseCapture('x due:today', WEDNESDAY).due).toBe('2026-09-23');
    expect(parseCapture('x due:+2w', WEDNESDAY).due).toBe('2026-10-07');
    expect(parseCapture('x due:2026-10-15', WEDNESDAY).due).toBe('2026-10-15');
  });

  test('waiting can say on whom', () => {
    expect(parseCapture('Get the contract back >waiting:Priya', WEDNESDAY)).toMatchObject({
      title: 'Get the contract back',
      state: 'waiting',
      waitingOn: 'Priya',
    });
  });

  test('a defer date means someday, and clashes with any other list', () => {
    expect(parseCapture('Learn Rust defer:+1m', WEDNESDAY)).toMatchObject({state: 'someday', defer: '2026-10-23'});
    expect(parseCapture('Learn Rust >next defer:+1m', WEDNESDAY).problems).toEqual([
      'a defer date only goes with >someday, not >next',
    ]);
  });

  test('nothing is taken that was not exactly a token', () => {
    expect(parseCapture('Compare A > B, ratio 3:2', WEDNESDAY)).toEqual({title: 'Compare A > B, ratio 3:2', tags: []});
    expect(parseCapture('Rename the >foo widget', WEDNESDAY)).toEqual({title: 'Rename the >foo widget', tags: []});
  });

  test('what looks meant but cannot be read is a problem, not a guess', () => {
    expect(parseCapture('Pay rent due:someday', WEDNESDAY).problems?.[0]).toContain('"someday" is not a date');
    expect(parseCapture('Pay rent >nex', WEDNESDAY).problems).toEqual(['">nex" — did you mean >next?']);
    expect(parseCapture('Pay rent >review', WEDNESDAY).problems).toBeUndefined();
    expect(parseCapture('#calls >next', WEDNESDAY).problems).toEqual([
      'there is no title left once the tokens are taken out',
    ]);
  });

  test('without a clock, dates are problems rather than guesses', () => {
    expect(parseCapture('Pay rent due:fri').problems?.[0]).toContain('is not a date');
  });
});

describe('what the last word wants completing as', () => {
  test('each marker asks for its own kind of thing', () => {
    expect(completing('Call Sam #ca')).toEqual({kind: 'tag', partial: 'ca', start: 10});
    expect(completing('Order tiles +kit')).toMatchObject({kind: 'project', partial: 'kit'});
    expect(completing('Order tiles >')).toMatchObject({kind: 'list', partial: ''});
    expect(completing('Pay rent due:fr')).toMatchObject({kind: 'date', partial: 'fr'});
  });

  test('a finished word, or plain text, asks for nothing', () => {
    expect(completing('Call Sam #calls ')).toBeUndefined();
    expect(completing('Call Sam')).toBeUndefined();
    expect(completing('email a#b')).toBeUndefined();
  });
});
