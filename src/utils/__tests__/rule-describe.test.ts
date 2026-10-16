import { describe, it, expect, vi } from 'vitest';

vi.mock('@actual-app/api', () => ({
  default: {},
  utils: {
    amountToInteger: (a: number) => Math.round(a * 100),
    integerToAmount: (c: number) => c / 100,
  },
}));

import { readable, type RuleNames } from '../rule-describe.js';

const names: RuleNames = {
  byId: new Map([
    ['p1', 'Cinema'],
    ['p2', 'Theatre'],
    ['c1', 'Fun'],
  ]),
  schedules: new Map([['s1', 'Rent']]),
  known: true,
};

/**
 * What the quotes in a rule listing mean.
 *
 * They used to go round every value, so a figure and the text of one printed
 * the same way, and so did a boolean and the word for it. Those pairs are the
 * difference between a rule that works and one that takes the next import
 * down with it (#183, #185), and the listing showed them identically.
 */
describe('a rule value, as the person who wrote it would read it', () => {
  it('prints a figure as money, with no quotes', () => {
    expect(readable(names, 'amount', -450000)).toBe('-4,500.00');
  });

  it('keeps the quotes on the text of a figure, which is the broken one', () => {
    // This is what takes an import down. The quotes are the only thing on the
    // line that says it is text, and the warning under it says the rest.
    expect(readable(names, 'amount', '-555')).toBe('"-555"');
  });

  it('prints true and false as themselves, and the word for one as text', () => {
    expect(readable(names, 'cleared', false)).toBe('false');
    expect(readable(names, 'cleared', true)).toBe('true');
    expect(readable(names, 'cleared', 'false')).toBe('"false"');
  });

  it('names an id without quotes, and quotes text that is not one', () => {
    // The name stands for something in the budget, so it is not the stored
    // text. A value the budget does not answer to is the stored text and
    // nothing more, which is what #167 and #170 left behind: a rule holding
    // the name where the id belongs, reading perfectly well and never
    // matching anything. On the line itself, the quotes are what tell them
    // apart.
    expect(readable(names, 'payee', 'p1')).toBe('Cinema');
    expect(readable(names, 'payee', 'Cinema')).toBe('"Cinema"');
    expect(readable(names, 'payee', 'p9')).toBe('"p9"');
  });

  it('reads each value in a list on its own', () => {
    // `"Cinema, Theatre"` reads as one payee with a comma in its name.
    expect(readable(names, 'payee', ['p1', 'p2'])).toBe('Cinema, Theatre');
    expect(readable(names, 'payee', ['p1', 'Spotify'])).toBe('Cinema, "Spotify"');
  });

  it('escapes a quote inside a value, so one value cannot read as two', () => {
    expect(readable(names, 'notes', 'a", "b')).toBe('"a\\", \\"b"');
  });

  it('quotes a name that would read as something else', () => {
    // A name goes bare, which is what tells a payee apart from a rule holding
    // the text of one. A payee called `true` or `123` would then read as a
    // boolean or a figure, so those few get the quotes back.
    const odd: RuleNames = {
      byId: new Map([
        ['p1', 'true'],
        ['p2', '123'],
        ['p3', '(none)'],
        ['p4', '"Netflix"'],
        ['p5', 'Jo"e'],
        ['p6', 'Super 24'],
        ['p7', '{x}'],
        ['p8', '[x]'],
      ]),
      schedules: new Map(),
      known: true,
    };
    expect(readable(odd, 'payee', 'p1')).toBe('"true"');
    expect(readable(odd, 'payee', 'p2')).toBe('"123"');
    expect(readable(odd, 'payee', 'p3')).toBe('"(none)"');
    expect(readable(odd, 'payee', 'p4')).toBe('"\\"Netflix\\""');
    // The stored config of an object is written out as JSON when there is
    // nothing better to say about it, so a name shaped like one reads as that.
    expect(readable(odd, 'payee', 'p7')).toBe('"{x}"');
    expect(readable(odd, 'payee', 'p8')).toBe('"[x]"');
    // An ordinary name with a quote in the middle reads as nothing else, so
    // it is left alone.
    expect(readable(odd, 'payee', 'p5')).toBe('Jo"e');
    // And a name that merely holds digits is a name. A figure is the whole
    // value and nothing else, so the test for one is anchored; loosened to
    // "has a digit in it", this shop would come back quoted, which says the
    // rule is holding the text of something rather than naming somebody.
    expect(readable(odd, 'payee', 'p6')).toBe('Super 24');
  });

  it('tells nothing apart from the empty text, which is a value', () => {
    // `null` and `""` are two different broken rules: on `amount` the first
    // sets every matching transaction to zero and the second takes the next
    // import down. They printed the same line.
    expect(readable(names, 'category', null)).toBe('(none)');
    expect(readable(names, 'category', undefined)).toBe('(none)');
    expect(readable(names, 'notes', '')).toBe('""');
    expect(readable(names, 'payee', [])).toBe('(empty list)');
  });

  it('says when a schedule runs rather than printing its stored config', () => {
    const recurrence = {
      start: '2026-11-01',
      frequency: 'monthly',
      patterns: [],
      skipWeekend: false,
      weekendSolveMode: 'after',
      endMode: 'never',
      endOccurrences: 1,
      endDate: '2026-11-01',
    };
    expect(readable(names, 'date', recurrence)).toBe('every month, from 2026-11-01');
  });

  it('writes out an object it cannot describe rather than stringifying it', () => {
    // `String({})` is `[object Object]`, which is what this was reported for.
    expect(readable(names, 'notes', { a: 1 })).toBe('{"a":1}');
  });

  it('shows both bounds of a range', () => {
    expect(readable(names, 'amount', { num1: -200000, num2: -100000 })).toBe(
      '-2,000.00 and -1,000.00',
    );
  });
});
