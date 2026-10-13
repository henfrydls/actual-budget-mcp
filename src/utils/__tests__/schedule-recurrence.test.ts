import { describe, it, expect } from 'vitest';
import { describeRecurrence } from '../schedule-recurrence.js';

/**
 * The recurrence of a schedule, in words (#182).
 *
 * Every shape here was taken from a schedule created through the engine's own
 * `schedule/create`, not from the issue: the issue reported `[object Object]`
 * and said nothing about what was inside it.
 *
 * The ones that return nothing matter as much as the ones that describe
 * something. Nothing means "print the value as it is", and a date condition
 * that is a plain day holds a string, so describing it from guesses would
 * replace a date someone can read with a sentence about a recurrence that
 * does not exist.
 */
describe('describing a schedule recurrence', () => {
  const monthly = {
    start: '2026-11-01',
    frequency: 'monthly',
    patterns: [],
    skipWeekend: false,
    weekendSolveMode: 'after',
    endMode: 'never',
    endOccurrences: 1,
    endDate: '2026-11-01',
  };

  it('describes the plain monthly case', () => {
    expect(describeRecurrence(monthly)).toBe('every month, from 2026-11-01');
  });

  it('counts the interval when there is one', () => {
    expect(describeRecurrence({ ...monthly, frequency: 'weekly', interval: 2 })).toBe(
      'every 2 weeks, from 2026-11-01',
    );
    // An interval of one is the default and saying "every 1 month" reads as a
    // setting someone chose.
    expect(describeRecurrence({ ...monthly, interval: 1 })).toBe('every month, from 2026-11-01');
  });

  it('names the day of the month', () => {
    expect(describeRecurrence({ ...monthly, patterns: [{ type: 'day', value: 15 }] })).toBe(
      'every month on day 15, from 2026-11-01',
    );
  });

  it('names a weekday by which one it is', () => {
    expect(describeRecurrence({ ...monthly, patterns: [{ type: 'FR', value: -1 }] })).toBe(
      'every month on the last Friday, from 2026-11-01',
    );
    expect(describeRecurrence({ ...monthly, patterns: [{ type: 'TU', value: 2 }] })).toBe(
      'every month on the second Tuesday, from 2026-11-01',
    );
  });

  it('joins two patterns', () => {
    expect(
      describeRecurrence({
        ...monthly,
        patterns: [
          { type: 'day', value: 1 },
          { type: 'day', value: 15 },
        ],
      }),
    ).toBe('every month on day 1 and day 15, from 2026-11-01');
  });

  it('says when it stops, in whichever way it stops', () => {
    expect(describeRecurrence({ ...monthly, endMode: 'on_date', endDate: '2030-11-01' })).toBe(
      'every month, from 2026-11-01, until 2030-11-01',
    );
    expect(
      describeRecurrence({ ...monthly, endMode: 'after_n_occurrences', endOccurrences: 10 }),
    ).toBe('every month, from 2026-11-01, 10 times');
    expect(
      describeRecurrence({ ...monthly, endMode: 'after_n_occurrences', endOccurrences: 1 }),
    ).toBe('every month, from 2026-11-01, 1 time');
  });

  it('ignores the end date a never-ending schedule still carries', () => {
    // Every schedule has `endDate` filled in whatever its `endMode` says, so
    // reading the date rather than the mode would put an end on all of them.
    expect(describeRecurrence({ ...monthly, endDate: '2030-01-01' })).toBe(
      'every month, from 2026-11-01',
    );
  });

  it('mentions the weekend rule only when it is on', () => {
    expect(describeRecurrence({ ...monthly, skipWeekend: true, weekendSolveMode: 'before' })).toBe(
      'every month, from 2026-11-01, weekends moved earlier',
    );
    expect(describeRecurrence({ ...monthly, skipWeekend: true, weekendSolveMode: 'after' })).toBe(
      'every month, from 2026-11-01, weekends moved later',
    );
    // Off is the common case, and a note on every line buries the ones where
    // it means something.
    expect(describeRecurrence(monthly)).not.toContain('weekend');
  });

  it('says nothing about a plain date, which is already readable', () => {
    expect(describeRecurrence('2026-12-05')).toBeUndefined();
  });

  it('says nothing about a shape it does not recognise', () => {
    // Rather than describing it from guesses. Both keys are required: an
    // object with one of them is not a recurrence.
    expect(describeRecurrence({ start: '2026-11-01' })).toBeUndefined();
    expect(describeRecurrence({ frequency: 'monthly' })).toBeUndefined();
    expect(describeRecurrence({})).toBeUndefined();
    expect(describeRecurrence(null)).toBeUndefined();
    expect(describeRecurrence(undefined)).toBeUndefined();
    expect(describeRecurrence([monthly])).toBeUndefined();
    expect(describeRecurrence(42)).toBeUndefined();
  });

  it('keeps an unknown frequency rather than dropping it', () => {
    // A frequency this does not know is still worth printing: the reader can
    // see the word the engine stored.
    expect(describeRecurrence({ ...monthly, frequency: 'fortnightly' })).toBe(
      'fortnightly, from 2026-11-01',
    );
  });

  it('skips a pattern it cannot read, keeping the rest of the line', () => {
    expect(
      describeRecurrence({
        ...monthly,
        patterns: [{ type: 'ZZ', value: 1 }, { type: 'day', value: 3 }],
      }),
    ).toBe('every month on day 3, from 2026-11-01');
    expect(describeRecurrence({ ...monthly, patterns: [{ type: 'ZZ', value: 1 }] })).toBe(
      'every month, from 2026-11-01',
    );
  });
});
