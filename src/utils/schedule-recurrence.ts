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
  [-1]: 'last',
};

const UNITS: Readonly<Record<string, [one: string, many: string]>> = {
  daily: ['day', 'days'],
  weekly: ['week', 'weeks'],
  monthly: ['month', 'months'],
  yearly: ['year', 'years'],
};

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

/** "day 15", "the last Friday". */
function describePattern(pattern: Pattern): string | undefined {
  const value = pattern.value;
  if (pattern.type === 'day') {
    return typeof value === 'number' ? `day ${value}` : undefined;
  }
  const weekday = typeof pattern.type === 'string' ? WEEKDAYS[pattern.type] : undefined;
  if (!weekday) return undefined;
  const which = typeof value === 'number' ? NTH[value] : undefined;
  return which ? `the ${which} ${weekday}` : weekday;
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
  const patterns = Array.isArray(value.patterns) ? (value.patterns as Pattern[]) : [];
  const described = patterns.map(describePattern).filter((p): p is string => p !== undefined);
  const howOftenPhrase =
    howOften(value.frequency as string, value.interval) +
    (described.length > 0 ? ` on ${described.join(' and ')}` : '');

  const parts: string[] = [howOftenPhrase, `from ${value.start as string}`];

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
