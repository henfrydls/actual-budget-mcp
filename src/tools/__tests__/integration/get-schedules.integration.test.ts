import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

vi.mock('@actual-app/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@actual-app/api')>();
  return { ...actual, sync: vi.fn().mockResolvedValue(undefined) };
});

vi.mock('../../../connection.js', () => ({
  ensureConnection: vi.fn().mockResolvedValue(undefined),
}));

import {
  initTestEngine,
  shutdownTestEngine,
  createFreshBudget,
  api,
  testInternal,
} from './actual-engine.js';
import { registerGetSchedules } from '../../read/get-schedules.js';

const skip = process.env.SKIP_ACTUAL_INTEGRATION === '1';

type Handler = () => Promise<{
  content: Array<{ type: string; text: string }>;
}>;

function handlerFor(): Handler {
  let handler: Handler | undefined;
  registerGetSchedules({
    tool: (...a: unknown[]) => {
      handler = a.at(-1) as Handler;
    },
  } as never);
  return handler as Handler;
}

/** Local calendar date, the same notion of a day the tool uses. */
function day(offset: number): string {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

const PAST = day(-30);
const SOON = day(60);
/**
 * A start date far enough ahead that the schedule's day never arrives while
 * the test runs. See the note below: a schedule that posts by itself and is
 * due makes the engine post it in the background.
 */
const AHEAD = day(30);

/**
 * Listing schedules against the real engine (#150).
 *
 * Every shape this tool reads is the engine's, and none of them is uniform:
 * a recurring schedule's `date` is an object and a one-off's is a string, an
 * `isbetween` rule puts the amount in `{num1, num2}` where every other rule
 * puts a number, and whether a schedule has posted is not in the schedule at
 * all but in the transaction that carries its id. Mocks can only repeat what
 * I believed; this is where the belief is checked.
 *
 * Two things the engine does decide how this file is written, both measured
 * by bisecting until one thing was left.
 *
 * A schedule that posts by itself, and whose day has arrived, is posted by
 * the engine in the background: `advanceSchedulesService` calls
 * `postTransactionForSchedule`, which runs a query, and in a test that query
 * lands after the budget is closed ("Cannot read properties of null"). It
 * fails the run without failing a test. Waiting before the close does not
 * drain it. Measured by varying one field at a time:
 *
 *   posts_transaction  day        run
 *   false              ahead      clean
 *   false              passed     clean
 *   true               ahead      clean
 *   true               passed     the stray rejection
 *
 * In a server the database is open and the write goes through, so this is
 * the harness and not the server. It is still kept out of here: the schedule
 * that posts by itself starts thirty days out, and a day that has already
 * passed belongs to the schedules that wait to be approved.
 *
 * And one that decides how the assertions below are written: a recurrence's
 * next date is not the same everywhere. `getNextDate` reads a stored
 * `YYYY-MM-DD` as UTC, so west of Greenwich an occurrence that has already
 * passed locally can still come back as the next one. Measured with the same
 * budget and the same schedule, a monthly starting on the 21st, on 22 October:
 *
 *   TZ=UTC                      next_date 2026-11-21
 *   TZ=America/Santo_Domingo    next_date 2026-10-21, which is yesterday
 *   TZ=Pacific/Auckland         next_date 2026-11-22
 *
 * The app shows the same thing, because it reads the same field. So nothing
 * here asserts that a schedule is or is not late: it asks the engine what
 * the next dates are and checks the listing says the same.
 */
describe.skipIf(skip)('listing real schedules (#150)', () => {
  let accountId = '';
  let savingsId = '';
  let payeeId = '';

  beforeAll(async () => {
    await initTestEngine();
    await createFreshBudget(async () => {
      accountId = (await api.createAccount(
        { name: 'Checking', offbudget: false } as never,
        0,
      )) as string;
      savingsId = (await api.createAccount(
        { name: 'Savings', offbudget: false } as never,
        0,
      )) as string;
      payeeId = (await api.createPayee({
        name: 'Landlord',
      } as never)) as string;
    }, 'get-schedules');

    // Monthly, named, with a payee and a single amount.
    await testInternal().send(
      'schedule/create' as never,
      {
        schedule: { name: 'Rent', posts_transaction: false },
        conditions: [
          { op: 'is', field: 'account', value: accountId },
          { op: 'is', field: 'payee', value: payeeId },
          {
            op: 'isapprox',
            field: 'date',
            value: {
              start: '2026-01-01',
              frequency: 'monthly',
              patterns: [],
              skipWeekend: false,
              weekendSolveMode: 'after',
              endMode: 'never',
              endOccurrences: 1,
              endDate: '2026-01-01',
            },
          },
          { op: 'is', field: 'amount', value: -450000 },
        ],
      } as never,
    );

    // Every other week, with no name and a range for the amount, which is
    // what the app writes unless a name is typed.
    await testInternal().send(
      'schedule/create' as never,
      {
        schedule: { posts_transaction: true },
        conditions: [
          { op: 'is', field: 'account', value: savingsId },
          {
            op: 'isapprox',
            field: 'date',
            value: {
              start: AHEAD,
              frequency: 'weekly',
              interval: 2,
              patterns: [],
              skipWeekend: false,
              weekendSolveMode: 'after',
              endMode: 'never',
              endOccurrences: 1,
              endDate: AHEAD,
            },
          },
          {
            op: 'isbetween',
            field: 'amount',
            value: { num1: -200000, num2: -100000 },
          },
        ],
      } as never,
    );

    // No account at all, which the app allows, and paid from one anyway.
    // The listing used to read the accounts its schedules named, so this one
    // was read from nowhere and reported as never having posted.
    await testInternal().send('schedule/create' as never, {
      schedule: { name: 'Gym', posts_transaction: false },
      conditions: [
        {
          op: 'isapprox',
          field: 'date',
          value: {
            start: '2026-01-03',
            frequency: 'monthly',
            patterns: [],
            skipWeekend: false,
            weekendSolveMode: 'after',
            endMode: 'never',
            endOccurrences: 1,
            endDate: '2026-01-03',
          },
        },
        { op: 'is', field: 'amount', value: -3000 },
      ],
    } as never);

    // One day only, still to come.
    await testInternal().send(
      'schedule/create' as never,
      {
        schedule: { name: 'Insurance', posts_transaction: false },
        conditions: [
          { op: 'is', field: 'account', value: accountId },
          { op: 'is', field: 'date', value: SOON },
          { op: 'is', field: 'amount', value: -120000 },
        ],
      } as never,
    );

    // What the rent paid last month looks like: a transaction carrying the
    // id of the schedule that produced it, which is the only place the
    // engine records that a schedule posted.
    const all = await api.getSchedules();
    const rent = all.find((s) => s.name === 'Rent');
    const gym = all.find((s) => s.name === 'Gym');
    await api.addTransactions(accountId, [
      { date: PAST, amount: -450000, schedule: rent?.id },
      { date: PAST, amount: -3000, schedule: gym?.id },
    ] as never);
  }, 60_000);

  afterAll(async () => {
    await shutdownTestEngine();
  });

  async function listing(): Promise<string> {
    const reply = await handlerFor()();
    return reply.content[0].text;
  }

  it('lists every schedule in the budget', async () => {
    const text = await listing();
    expect(text).toContain('=== Schedules (4) ===');
    expect(text).toContain('Rent');
    expect(text).toContain('Insurance');
  });

  it('shows amounts as amounts, including a range', async () => {
    const text = await listing();
    expect(text).toContain('-4,500.00');
    expect(text, 'the stored integer should be gone').not.toContain('450000');
    // The shape only an `isbetween` rule produces.
    expect(text).toContain('-2,000.00 to -1,000.00');
  });

  it('says how often each one happens, and never as [object Object]', async () => {
    const text = await listing();
    expect(text).not.toContain('[object Object]');
    expect(text).toContain('every month, from 2026-01-01');
    // The interval lives beside the frequency, so the stored word "weekly"
    // on its own would call this one weekly.
    expect(text).toMatch(new RegExp(`every 2 weeks on \\w+, from ${AHEAD}`));
  });

  it('calls a schedule that happens once "once"', async () => {
    const text = await listing();
    expect(text.match(/\bonce\b/g)).toHaveLength(1);
  });

  it('names the account and the payee behind the ids', async () => {
    const text = await listing();
    expect(text).toContain('Checking / Landlord');
    // No payee on that one, so the account stands alone.
    expect(text).toMatch(/Savings\n/);
    expect(text, 'no uuid should reach the reply').not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/);
  });

  it('says a schedule is late when the engine says its day has passed', async () => {
    const text = await listing();
    const today = day(0);
    const late = (await api.getSchedules()).filter(
      (s) => typeof s.next_date === 'string' && s.next_date < today,
    );

    expect(text.match(/due since/g) ?? []).toHaveLength(late.length);
    for (const schedule of late) {
      expect(text).toContain(`due since ${schedule.next_date}`);
    }
  });

  it('sorts by the day each one is next due', async () => {
    const text = await listing();
    // Rent repeats monthly, so its next day is inside a month; the one-off
    // is sixty days out. True in any timezone, which the dates themselves
    // are not.
    expect(text.indexOf('Rent')).toBeLessThan(text.indexOf('Insurance'));
  });

  it('reports the transaction a schedule posted, and says so when there is none', async () => {
    const text = await listing();
    expect(text).toContain(`last posted ${PAST}`);
    expect(text).toContain('nothing posted in the last 365 days');
  });

  it('finds what a schedule with no account of its own posted', async () => {
    // One query over every transaction that carries a schedule id, rather
    // than one per account named by a schedule: a schedule need not name an
    // account, and one that does can still be paid from another.
    const text = await listing();
    const gym = text.split('\n').find((line) => line.startsWith('Gym'));
    const under = text.split('\n')[text.split('\n').indexOf(gym as string) + 1];

    expect(gym).toBeDefined();
    expect(under).toContain(`last posted ${PAST}`);
  });

  it('says who posts each one', async () => {
    const text = await listing();
    expect(text).toContain('posts by itself');
    expect(text).toContain('waits to be approved');
  });
});
