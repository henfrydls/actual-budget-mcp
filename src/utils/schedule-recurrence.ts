/**
 * The date condition of a schedule, in words (#182).
 *
 * A rule Actual creates for a schedule holds a recurrence object where every
 * other rule holds a date, and `get_rules` printed it with `String()`, so the
 * line read `IF date isapprox "[object Object]"`. Every schedule in the budget
 * listed the same thing, which is the one condition that says what the
 * schedule is for.
 *
 * Measured against the engine, from schedules created through
 * `schedule/create`, these are the shapes it stores:
 *
 *   {start, frequency: "monthly", patterns: [], skipWeekend: false,
 *    weekendSolveMode: "after", endMode: "never", endOccurrences, endDate}
 *   {..., frequency: "weekly", interval: 2, skipWeekend: true,
 *    weekendSolveMode: "before", endMode: "after_n_occurrences"}
 *   {..., patterns: [{type: "day", value: 15}]}
 *   {..., patterns: [{type: "FR", value: -1}]}       the last Friday
 *   {..., endMode: "on_date", endDate: "2030-11-01"}
 *
 * A plain date is stored as a string on the same field, and that one was
 * already readable, so it is left alone: this returns nothing for anything
 * that is not a recurrence, and the caller prints what it has.
 *
 * ## Patterns belong to monthly, and nothing else
 *
 * `recurConfigToRSchedule` applies `patterns` only when the frequency is
 * monthly; daily, weekly and yearly each return the base rule and ignore them.
 * The app leaves them behind all the same: its picker opens on monthly with a
 * pattern for today, and switching to weeks clears them only by looking at the
 * frequency it came from. So a weekly schedule carrying `[{day: 12}]` is
 * ordinary, and the first version of this read it out as "every week on day
 * 12".
 *
 * Measured through `schedule/get-upcoming-dates`, from 2026-10-12, a Monday:
 *
 *   weekly,  patterns [{day, 12}]   12 Oct, 19 Oct, 26 Oct, 2 Nov   every Monday
 *   weekly,  no patterns            12 Oct, 19 Oct, 26 Oct, 2 Nov   the same
 *   yearly,  patterns [{TU, 2}]     12 Oct 2026, 2027, 2028, 2029   the same day
 *   daily/3, patterns [{day, 12}]   12, 15, 18, 21 Oct              every third day
 *   monthly, patterns [{day, 15}]   15 Oct, 15 Nov, 15 Dec          here they count
 *   monthly, patterns [{day, -1}]   31 Oct, 30 Nov, 31 Dec          the last day
 *
 * So patterns are read on monthly only, and a weekly is described by the
 * weekday its start falls on, which is what the app shows.
 */

interface Pattern {
  type?: unknown;
  value?: unknown;
}

interface Recurrence {
  start?: unknown;
  frequency?: unknown;
  interval?: unknown;
  patterns?: unknown;
  skipWeekend?: unknown;
  weekendSolveMode?: unknown;
  endMode?: unknown;
  endDate?: unknown;
  endOccurrences?: unknown;
}

/** The engine's two-letter weekday codes. */
const WEEKDAYS: Readonly<Record<string, string>> = {
  SU: 'Sunday',
  MO: 'Monday',
  TU: 'Tuesday',
  WE: 'Wednesday',
  TH: 'Thursday',
  FR: 'Friday',
  SA: 'Saturday',
};

/** Which one in the month, as the app's own picker words it. */
const NTH: Readonly<Record<number, string>> = {
  1: 'first',
  2: 'second',
  3: 'third',
  4: 'fourth',
  // The app's picker allows a fifth, and the months without one are simply
  // skipped: measured, `[{MO, 5}]` from October 2026 falls on 30 Nov 2026,
  // 29 Mar 2027, 31 May 2027. Missing it described that as "every month on
  // Monday", which is wrong about the month and about the Monday.
  5: 'fifth',
  [-1]: 'last',
};

const UNITS: Readonly<Record<string, [one: string, many: string]>> = {
  daily: ['day', 'days'],
  weekly: ['week', 'weeks'],
  monthly: ['month', 'months'],
  yearly: ['year', 'years'],
};

/** The weekday a `YYYY-MM-DD` falls on, counted in UTC so no offset can shift it. */
function weekdayOf(date: string): string | undefined {
  const parts = date.split('-').map(Number);
  if (parts.length !== 3 || parts.some((n) => !Number.isFinite(n))) return undefined;
  const [year, month, day] = parts;
  const names = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  return names[new Date(Date.UTC(year, month - 1, day)).getUTCDay()];
}

function isRecurrence(value: unknown): value is Recurrence {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const candidate = value as Recurrence;
  // Both, not either: a date condition is the only object on this field, and
  // an object missing one of these is not something to describe from guesses.
  return typeof candidate.start === 'string' && typeof candidate.frequency === 'string';
}

/** "every month", "every 2 weeks". */
function howOften(frequency: string, interval: unknown): string {
  const unit = UNITS[frequency];
  if (!unit) return frequency;
  const every = typeof interval === 'number' && interval > 1 ? interval : 1;
  return every === 1 ? `every ${unit[0]}` : `every ${every} ${unit[1]}`;
}

/**
 * "the last Friday", for the patterns that name a weekday.
 *
 * Nothing when the ordinal is not one it knows. Returning the weekday on its
 * own would say "on Monday" about a rule that fires on one Monday a month,
 * and an ordinal outside the picker's range is not a schedule that quietly
 * does something else: measured, `{MO, 9}` makes the engine give up looking
 * ("Failed to find a matching occurrence in 50 iterations") and `{MO, 0}` is
 * refused outright. Describing those from the half that parses is the mistake
 * this module was corrected for once already.
 */
function describeWeekdayPattern(pattern: Pattern): string | undefined {
  const weekday = typeof pattern.type === 'string' ? WEEKDAYS[pattern.type] : undefined;
  if (!weekday) return undefined;
  const which = typeof pattern.value === 'number' ? NTH[pattern.value] : undefined;
  return which ? `the ${which} ${weekday}` : undefined;
}

/**
 * Whether this can name the day a pattern asks for.
 *
 * The engine takes any whole number from -31 to 31 except zero, and the
 * negatives count back from the end of the month: measured,
 * `[{day, -2}, {day, 3}]` falls on 30 October, 3 November, 29 November,
 * 3 December, so -2 is the day before last and it happens. Only -1 has a name
 * here, so the rest invalidate the sentence rather than being dropped from it,
 * which is what made `[{day, -2}, {day, 3}]` read as "on the 3rd".
 *
 * Outside that range the engine refuses the config ("byDayOfMonth" values must
 * be `num !== 0 && num <= 31 && num >= -31`), and a fractional day makes it
 * give up looking. Neither is a schedule doing something this could describe.
 */
function canNameDay(value: unknown): value is number {
  if (typeof value !== 'number' || !Number.isInteger(value)) return false;
  return value === -1 || (value >= 1 && value <= 31);
}

/** 1st, 2nd, 3rd, 4th, 11th, 21st. */
function ordinal(day: number): string {
  const inHundred = day % 100;
  if (inHundred >= 11 && inHundred <= 13) return `${day}th`;
  switch (day % 10) {
    case 1:
      return `${day}st`;
    case 2:
      return `${day}nd`;
    case 3:
      return `${day}rd`;
    default:
      return `${day}th`;
  }
}

/**
 * The days of the month, in the order they happen.
 *
 * `-1` is the last day of the month, measured: 31 Oct, 30 Nov, 31 Dec. Printing
 * it as "day -1" leaks the storage, and leaving it where it was written puts
 * the end of the month before the middle of it.
 */
function describeDayPatterns(days: number[]): string | undefined {
  if (days.length === 0) return undefined;
  // The same day twice changes nothing: measured, `[{day, 5}, {day, 5}]`
  // falls on the 5th of each month, once.
  const unique = [...new Set(days)];
  const numbered = unique.filter((d) => d > 0).sort((a, b) => a - b);
  const hasLast = unique.some((d) => d === -1);
  const parts = [...numbered.map(ordinal), ...(hasLast ? ['last day'] : [])];

  if (parts.length === 1) return `the ${parts[0]}`;
  const head = parts.slice(0, -1).join(', ');
  return `the ${head} and ${parts[parts.length - 1]}`;
}

/**
 * A recurrence in one line, or nothing if the value is not one.
 *
 * Nothing is the signal to print the value as it is: a schedule whose date is
 * a single day holds a string, and a shape this does not recognise is better
 * shown raw than described wrongly.
 */
export function describeRecurrence(value: unknown): string | undefined {
  if (!isRecurrence(value)) return undefined;

  // The pattern belongs to the frequency, so they read as one phrase: "every
  // month on day 15", not "every month, on day 15".
  const start = value.start as string;
  let on: string | undefined;

  if (value.frequency === 'monthly') {
    const patterns = Array.isArray(value.patterns) ? (value.patterns as Pattern[]) : [];
    // An entry that is not an object at all, which would otherwise throw on
    // the first property read and take the whole listing with it.
    if (patterns.some((p) => typeof p !== 'object' || p === null)) return undefined;

    const dayPatterns = patterns.filter((p) => p.type === 'day');
    if (!dayPatterns.every((p) => canNameDay(p.value))) return undefined;
    const days = describeDayPatterns(dayPatterns.map((p) => p.value as number));

    const weekdays: string[] = [];
    const seen = new Set<string>();
    for (const pattern of patterns.filter((p) => p.type !== 'day')) {
      const described = describeWeekdayPattern(pattern);
      // One pattern nobody can read makes the whole sentence a lie by
      // omission: the schedule does something this line would not mention.
      // The caller prints the stored config instead, which is true.
      if (described === undefined) return undefined;
      // The same weekday twice is the same weekday: measured,
      // `[{MO, 1}, {MO, 1}]` falls on the first Monday, once.
      if (seen.has(described)) continue;
      seen.add(described);
      weekdays.push(described);
    }

    const both = [...(days ? [days] : []), ...weekdays];
    if (both.length > 0) on = both.join(' and ');
  } else if (value.frequency === 'weekly') {
    // The engine ignores patterns here and repeats the start, so the weekday
    // it falls on is what actually happens, and what the app shows.
    on = weekdayOf(start);
  }

  const howOftenPhrase =
    howOften(value.frequency as string, value.interval) + (on ? ` on ${on}` : '');

  const parts: string[] = [howOftenPhrase, `from ${start}`];

  if (value.endMode === 'on_date' && typeof value.endDate === 'string') {
    parts.push(`until ${value.endDate}`);
  } else if (value.endMode === 'after_n_occurrences' && typeof value.endOccurrences === 'number') {
    parts.push(`${value.endOccurrences} time${value.endOccurrences === 1 ? '' : 's'}`);
  }

  // Only when it is on: every schedule carries the field, and saying "weekends
  // kept" on each of them would bury the ones where it means something.
  if (value.skipWeekend === true) {
    parts.push(
      value.weekendSolveMode === 'before'
        ? 'weekends moved earlier'
        : 'weekends moved later',
    );
  }

  return parts.join(', ');
}
