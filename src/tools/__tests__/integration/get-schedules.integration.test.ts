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
/** A single day still to come, and the day a payment for it is made. */
const BILL = day(10);
const BILL_PAID = day(8);

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
 * The engine's daily service writes when a schedule gives it something to
 * do, and in a test that write lands after the budget is closed ("Cannot
 * read properties of null"). It fails the run without failing a test, and
 * waiting before the close does not drain it, because closing is what runs
 * it. Two ways to give it something to do, both measured here:
 *
 *   posting one      `advanceSchedulesService` calls
 *                    `postTransactionForSchedule` for a schedule that posts
 *                    by itself, has an account to post into, and whose day
 *                    is today or has passed. Twelve combinations, one field
 *                    at a time: no account is clean whatever else is set,
 *                    `posts_transaction: false` is clean whatever the day,
 *                    and a day still ahead is clean.
 *
 *   finishing one    a single day that has passed and has a payment linked
 *                    to it is completed, through `updateSchedule`. Measured
 *                    four ways: a single day ahead is clean paid or not,
 *                    and one that has passed is clean until it is paid.
 *
 * In a server the database is open and the write goes through, so this is
 * the harness and not the server. Both are kept out of here all the same:
 * the schedule that posts by itself starts thirty days out, the one whose
 * day has passed is not paid, and the one that is paid early is for a day
 * still to come.
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
  let cashId = '';
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
      // Named by no schedule, which is the point: the payment below is
      // invisible to anything that reads the accounts its schedules name.
      cashId = (await api.createAccount({ name: 'Cash', offbudget: false } as never, 0)) as string;
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

    // A day that has passed and nothing paid: late in every timezone.
    await testInternal().send('schedule/create' as never, {
      schedule: { name: 'Membership', posts_transaction: false },
      conditions: [
        { op: 'is', field: 'account', value: accountId },
        { op: 'is', field: 'date', value: PAST },
        { op: 'is', field: 'amount', value: -60000 },
      ],
    } as never);

    // Monthly, and paid below on whatever day the engine says it is next
    // due, so it is a schedule whose day is covered in any timezone.
    await testInternal().send('schedule/create' as never, {
      schedule: { name: 'Power', posts_transaction: false },
      conditions: [
        { op: 'is', field: 'account', value: accountId },
        {
          op: 'isapprox',
          field: 'date',
          value: {
            start: '2026-01-05',
            frequency: 'monthly',
            patterns: [],
            skipWeekend: false,
            weekendSolveMode: 'after',
            endMode: 'never',
            endOccurrences: 1,
            endDate: '2026-01-05',
          },
        },
        { op: 'is', field: 'amount', value: -90000 },
      ],
    } as never);

    // A single day, made the way the API makes one. Measured on 26.10:
    // `api.createSchedule` writes an `isapprox` date condition even for a
    // single day, so this one has the two early days and the app calls it
    // paid when it is paid early. Guessing the operator from the date being
    // a string took those two days away and left it unpaid, which is the
    // same mistake that calls a bill that has been paid late when the day
    // has passed.
    await api.createSchedule({
      name: 'Api Bill',
      posts_transaction: false,
      account: accountId,
      amount: -45000,
      amountOp: 'is',
      date: BILL,
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
    const power = all.find((s) => s.name === 'Power');

    // The rent went out as a split across two categories, which is an
    // ordinary way to pay one. A query that leaves split parents out, which
    // is what AQL does unless it is told otherwise, cannot see it (#79, #82).
    await api.addTransactions(accountId, [
      {
        date: PAST,
        amount: -450000,
        schedule: rent?.id,
        subtransactions: [{ amount: -300000 }, { amount: -150000 }],
      },
    ] as never);

    // Paid from an account no schedule names.
    await api.addTransactions(cashId, [{ date: PAST, amount: -3000, schedule: gym?.id }] as never);

    // Paid on the day it is next due, whatever day the engine worked out.
    await api.addTransactions(accountId, [
      { date: power?.next_date as string, amount: -90000, schedule: power?.id },
    ] as never);

    // Paid two days before the day it is for.
    const bill = all.find((s) => s.name === 'Api Bill');
    await api.addTransactions(accountId, [
      { date: BILL_PAID, amount: -45000, schedule: bill?.id },
    ] as never);
  }, 60_000);

  afterAll(async () => {
    await shutdownTestEngine();
  });

  async function listing(): Promise<string> {
    const reply = await handlerFor()();
    return reply.content[0].text;
  }

  /** The second line of a named schedule, which is where its state is. */
  async function under(name: string): Promise<string> {
    const lines = (await listing()).split('\n');
    const at = lines.findIndex((line) => line.startsWith(name));
    expect(at, `${name} should be listed`).toBeGreaterThan(-1);
    return lines[at + 1];
  }

  it('lists every schedule in the budget', async () => {
    const text = await listing();
    expect(text).toContain('=== Schedules (7) ===');
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
    // The three single days: one still to come, one that passed, and the
    // one the API made.
    const text = await listing();
    expect(text.match(/\bonce\b/g)).toHaveLength(3);
    expect(await under('Insurance')).toContain('once');
    expect(await under('Membership')).toContain('once');
    expect(await under('Api Bill')).toContain('once');
  });

  it('names the account and the payee behind the ids', async () => {
    const text = await listing();
    expect(text).toContain('Checking / Landlord');
    // No payee on that one, so the account stands alone.
    expect(text).toMatch(/Savings\n/);
    expect(text, 'no uuid should reach the reply').not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/);
  });

  it('says a schedule whose day has passed and is unpaid is late', async () => {
    expect(await under('Membership')).toContain(`due since ${PAST}`);
  });

  it('allows the early days the engine allows, by reading the condition', async () => {
    // Whether the date condition is `is` or `isapprox` is not in what
    // `getSchedules` returns. It is read from the schedules table in the
    // same breath as the payments, because guessing it is wrong in both
    // directions.
    const bill = await under('Api Bill');

    expect(bill).toContain('paid');
    expect(bill).toContain(`already posted for ${BILL_PAID}`);
  });

  it('does not call a schedule late when its day is already paid', async () => {
    // The app answers paid before missed, and the engine only moves a
    // schedule on when its daily service runs. Until then the next date
    // still points at the day that was paid, so this is every budget
    // between a payment and the next run, and every budget in a timezone
    // west of Greenwich from the moment the schedule is made.
    const paid = await under('Power');

    expect(paid).toContain('paid');
    expect(paid).not.toContain('due since');
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
    // than one per account named by a schedule: this one names none, and it
    // was paid from an account no schedule names, so a per-account read
    // cannot see it however many accounts it reads.
    expect(await under('Gym')).toContain(`last posted ${PAST}`);
  });

  it('finds a payment that was split across categories', async () => {
    // A split is a parent row, and an AQL query leaves parents out unless it
    // says otherwise. Paying the rent across two categories is ordinary.
    expect(await under('Rent')).toContain(`last posted ${PAST}`);
  });

  it('says who posts each one', async () => {
    const text = await listing();
    expect(text).toContain('posts by itself');
    expect(text).toContain('waits to be approved');
  });
});
