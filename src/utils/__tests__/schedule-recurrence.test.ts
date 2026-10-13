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
    // 2026-11-01 is a Sunday, and a weekly repeats its start, so the weekday
    // is part of what it does.
    expect(describeRecurrence({ ...monthly, frequency: 'weekly', interval: 2 })).toBe(
      'every 2 weeks on Sunday, from 2026-11-01',
    );
    // An interval of one is the default and saying "every 1 month" reads as a
    // setting someone chose.
    expect(describeRecurrence({ ...monthly, interval: 1 })).toBe('every month, from 2026-11-01');
  });

  it('ignores patterns on a frequency the engine ignores them on', () => {
    // The engine applies patterns only on monthly: daily, weekly and yearly
    // return the base rule. The app leaves them behind anyway, because its
    // picker starts on monthly and clears them by looking at the frequency it
    // came from, so a weekly schedule carrying a day pattern is ordinary.
    //
    // Measured from 2026-10-12, a Monday, through the engine's own
    // `get-upcoming-dates`: a weekly with `[{day: 12}]` falls on the 12th,
    // 19th and 26th of October, which is every Monday, and a yearly with
    // `[{TU, 2}]` falls on 12 October of each year. Reading those patterns
    // out loud described days nothing happens on.
    expect(
      describeRecurrence({
        ...monthly,
        start: '2026-10-12',
        frequency: 'weekly',
        patterns: [{ type: 'day', value: 12 }],
      }),
    ).toBe('every week on Monday, from 2026-10-12');

    expect(
      describeRecurrence({
        ...monthly,
        start: '2026-10-12',
        frequency: 'yearly',
        patterns: [{ type: 'TU', value: 2 }],
      }),
    ).toBe('every year, from 2026-10-12');

    expect(
      describeRecurrence({
        ...monthly,
        start: '2026-10-12',
        frequency: 'daily',
        interval: 3,
        patterns: [{ type: 'day', value: 12 }],
      }),
    ).toBe('every 3 days, from 2026-10-12');
  });

  it('names the weekday a weekly falls on, as the app does', () => {
    // With no pattern involved at all: the start is what repeats.
    expect(
      describeRecurrence({ ...monthly, start: '2026-11-06', frequency: 'weekly', interval: 2 }),
    ).toBe('every 2 weeks on Friday, from 2026-11-06');
    expect(
      describeRecurrence({ ...monthly, start: '2026-10-14', frequency: 'weekly' }),
    ).toBe('every week on Wednesday, from 2026-10-14');
  });

  it('calls the last day of the month what it is', () => {
    // `-1` is the last day: measured, 31 Oct, 30 Nov, 31 Dec. "day -1" leaks
    // how it is stored.
    expect(describeRecurrence({ ...monthly, patterns: [{ type: 'day', value: -1 }] })).toBe(
      'every month on the last day, from 2026-11-01',
    );

    // Measured: `[{day, -1}, {day, 10}]` falls on 31 Oct, 10 Nov, 30 Nov,
    // 10 Dec, so both days count and the order is not the stored one.
    expect(
      describeRecurrence({
        ...monthly,
        patterns: [
          { type: 'day', value: -1 },
          { type: 'day', value: 10 },
        ],
      }),
    ).toBe('every month on the 10th and last day, from 2026-11-01');

    // The same day twice is the same day: measured, `[{day, 5}, {day, 5}]`
    // falls on the 5th, once.
    expect(
      describeRecurrence({
        ...monthly,
        patterns: [
          { type: 'day', value: 5 },
          { type: 'day', value: 5 },
        ],
      }),
    ).toBe('every month on the 5th, from 2026-11-01');
  });

  it('puts the days of the month in the order they happen', () => {
    // Stored in whatever order they were picked, and the last day is stored
    // as a negative number, so printing them as written puts the end of the
    // month in the middle.
    expect(
      describeRecurrence({
        ...monthly,
        patterns: [
          { type: 'day', value: 15 },
          { type: 'day', value: 1 },
          { type: 'day', value: -1 },
        ],
      }),
    ).toBe('every month on the 1st, 15th and last day, from 2026-11-01');
  });

  it('names the day of the month', () => {
    expect(describeRecurrence({ ...monthly, patterns: [{ type: 'day', value: 15 }] })).toBe(
      'every month on the 15th, from 2026-11-01',
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
    ).toBe('every month on the 1st and 15th, from 2026-11-01');
  });

  it('joins a day and a weekday', () => {
    expect(
      describeRecurrence({
        ...monthly,
        patterns: [
          { type: 'day', value: 1 },
          { type: 'FR', value: -1 },
        ],
      }),
    ).toBe('every month on the 1st and the last Friday, from 2026-11-01');
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

  it('names the fifth weekday of the month, which the picker allows', () => {
    // Measured from October 2026: `[{MO, 5}]` falls on 30 Nov 2026, 29 Mar
    // 2027, 31 May 2027. The months without a fifth Monday are skipped, so
    // it is neither every month nor any Monday, and leaving the ordinal out
    // said both.
    expect(describeRecurrence({ ...monthly, patterns: [{ type: 'MO', value: 5 }] })).toBe(
      'every month on the fifth Monday, from 2026-11-01',
    );
  });

  it('says nothing when a day is one it cannot name', () => {
    // The engine counts negatives back from the end of the month, and only
    // -1 has a name here. Measured, `[{day, -2}, {day, 3}]` falls on 30 Oct,
    // 3 Nov, 29 Nov, 3 Dec: the day before last happens, and dropping it left
    // "on the 3rd", a sentence missing half of what the schedule does.
    expect(
      describeRecurrence({
        ...monthly,
        patterns: [
          { type: 'day', value: -2 },
          { type: 'day', value: 3 },
        ],
      }),
    ).toBeUndefined();

    // Outside the range the engine takes at all: it refuses 0 and 32
    // ("byDayOfMonth" values must be `num !== 0 && num <= 31 && num >= -31`)
    // and gives up looking on a fractional day.
    for (const day of [0, 32, 1.5, -40]) {
      expect(
        describeRecurrence({ ...monthly, patterns: [{ type: 'day', value: day }] }),
        `day ${day}`,
      ).toBeUndefined();
    }

    // And 31 is a real day, even though February has none: measured, it
    // falls on 31 Oct, 31 Dec, 31 Jan, 31 Mar, skipping the months without.
    expect(describeRecurrence({ ...monthly, patterns: [{ type: 'day', value: 31 }] })).toBe(
      'every month on the 31st, from 2026-11-01',
    );
  });

  it('counts the same weekday twice as once', () => {
    // Measured: `[{MO, 1}, {MO, 1}]` falls on the first Monday, once.
    expect(
      describeRecurrence({
        ...monthly,
        patterns: [
          { type: 'MO', value: 1 },
          { type: 'MO', value: 1 },
        ],
      }),
    ).toBe('every month on the first Monday, from 2026-11-01');
  });

  it('writes the awkward ordinals the way English does', () => {
    // 11, 12 and 13 are the ones a naive rule gets wrong, and they are real
    // days of the month.
    expect(
      describeRecurrence({
        ...monthly,
        patterns: [
          { type: 'day', value: 11 },
          { type: 'day', value: 12 },
          { type: 'day', value: 13 },
        ],
      }),
    ).toBe('every month on the 11th, 12th and 13th, from 2026-11-01');

    // Against the ones that follow the simple rule, so the test cannot pass
    // by everything being "th".
    expect(
      describeRecurrence({
        ...monthly,
        patterns: [
          { type: 'day', value: 21 },
          { type: 'day', value: 22 },
          { type: 'day', value: 23 },
        ],
      }),
    ).toBe('every month on the 21st, 22nd and 23rd, from 2026-11-01');
  });

  it('says nothing when a pattern is not even an object', () => {
    // It used to throw on the first property read, which takes the whole
    // listing with it rather than one line of it.
    expect(() =>
      describeRecurrence({ ...monthly, patterns: [null, { type: 'day', value: 3 }] }),
    ).not.toThrow();
    expect(
      describeRecurrence({ ...monthly, patterns: [null, { type: 'day', value: 3 }] }),
    ).toBeUndefined();
  });

  it('says nothing at all when one pattern means nothing to it', () => {
    // Rather than describing the half it understands. A sentence that leaves
    // out one of the days a schedule fires on is worse than the stored
    // config, which the caller prints instead and which is at least true.
    //
    // Measured on the ordinals outside the picker's range: `{MO, 9}` makes
    // the engine give up ("Failed to find a matching occurrence in 50
    // iterations") and `{MO, 0}` is refused by its own validation. Neither is
    // a schedule quietly doing something else.
    expect(
      describeRecurrence({
        ...monthly,
        patterns: [{ type: 'ZZ', value: 1 }, { type: 'day', value: 3 }],
      }),
    ).toBeUndefined();
    expect(describeRecurrence({ ...monthly, patterns: [{ type: 'MO', value: 9 }] })).toBeUndefined();
    expect(describeRecurrence({ ...monthly, patterns: [{ type: 'MO', value: 0 }] })).toBeUndefined();
    expect(
      describeRecurrence({ ...monthly, patterns: [{ type: 'day', value: 'tenth' }] }),
    ).toBeUndefined();
  });
});
