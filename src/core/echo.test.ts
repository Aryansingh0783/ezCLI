import { describe, expect, it } from 'vitest';
import { findEchoRows, normRow } from './echo';

const rows = (text: string) => text.split('\n').map(normRow);

describe('findEchoRows', () => {
  it('matches a short message to its prompt line, not to the model quoting it while thinking', () => {
    const flat = rows(
      ['> What is Rust?', '', 'Rust is a language.', '', '> HI', '', '[Start thinking]', 'The user said HI, so greet them. HI is short.', '[End thinking]', '', 'Hello!', '', '> '].join('\n')
    );
    expect(findEchoRows(flat, ['What is Rust?', 'HI'])).toEqual([0, 4]);
  });

  it('matches a message sent twice to its own echo each time', () => {
    const flat = rows('> again\nfirst answer\n> again\nsecond answer');
    expect(findEchoRows(flat, ['again', 'again'])).toEqual([0, 2]);
  });

  it('accepts other prompt marks and a row that is only the message', () => {
    expect(findEchoRows(rows('❯ build it\nok'), ['build it'])).toEqual([0]);
    expect(findEchoRows(rows('banner\nbuild it\nok'), ['build it'])).toEqual([1]);
  });

  it('falls back to a row that contains the message when the CLI decorates its echo', () => {
    expect(findEchoRows(rows('You: explain the cache  [12:01]\nIt stores things.'), ['explain the cache'])).toEqual([0]);
  });

  it('uses only the start of a long message, which the terminal wraps', () => {
    const long = 'Please review the uncommitted changes in this repository and point out bugs';
    expect(findEchoRows(rows(`> Please review the uncommitted changes in this\n... repository and point out bugs\nSure.`), [long])).toEqual([0]);
  });

  it('skips finished turns and reports a turn whose echo has scrolled away', () => {
    expect(findEchoRows(rows('> second\nanswer'), [null, 'second'])).toEqual([-1, 0]);
    expect(findEchoRows(rows('> second\nanswer'), ['first', 'second'])).toEqual([-1, 0]);
  });
});
