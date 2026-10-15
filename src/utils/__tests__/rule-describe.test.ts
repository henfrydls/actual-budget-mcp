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

  it('names an id and quotes the name, because a name is text', () => {
    expect(readable(names, 'payee', 'p1')).toBe('"Cinema"');
    // An id nothing answers to is printed as it is, which is what the warning
    // beside it is about.
    expect(readable(names, 'payee', 'p9')).toBe('"p9"');
  });

  it('quotes each value in a list, not the list', () => {
    // `"Cinema, Theatre"` reads as one payee with a comma in its name.
    expect(readable(names, 'payee', ['p1', 'p2'])).toBe('"Cinema", "Theatre"');
  });

  it('says nothing and an empty list in words, and does not quote either', () => {
    // Neither is a value, so quoting them reads as text somebody typed.
    expect(readable(names, 'category', null)).toBe('(none)');
    expect(readable(names, 'category', '')).toBe('(none)');
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
