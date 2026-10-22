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
 * Listing schedules against the real engine (#150).
 *
 * Every shape this tool reads is the engine's, and none of them is uniform:
 * a recurring schedule's `date` is an object and a one-off's is a string, an
 * `isbetween` rule puts the amount in `{num1, num2}` where every other rule
 * puts a number, and whether a schedule has posted is not in the schedule at
 * all but in the transaction that carries its id. Mocks can only repeat what
 * I believed; this is where the belief is checked.
 *
 * Two things the engine does are measured here and worked around rather than
 * fought, both found by bisecting until one call was left:
 *
 *   `api.createSchedule` leaves a rejected promise behind on 26.10
 *   ("Cannot read properties of null (reading 'transaction')"), enough to
 *   fail a run on its own; a control with that one call removed exits clean.
 *   So the schedules here are created through `schedule/create`, which is
 *   what the app calls.
 *
 *   A schedule for a single day that has passed queues a write the engine
 *   only runs when the budget closes, which then lands on a closed database.
 *   Waiting before the close does not drain it, because closing is what
 *   runs it. In a server the database is still open and the write goes
 *   through, so this is the harness, not the server; it is kept out of here
 *   all the same, and the "due since" line is covered in the unit tests.
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
              start: '2026-01-02',
              frequency: 'weekly',
              interval: 2,
              patterns: [],
              skipWeekend: false,
              weekendSolveMode: 'after',
              endMode: 'never',
              endOccurrences: 1,
              endDate: '2026-01-02',
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
    const rent = (await api.getSchedules()).find((s) => s.name === 'Rent');
    await api.addTransactions(accountId, [
      { date: PAST, amount: -450000, schedule: rent?.id },
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
    expect(text).toContain('=== Schedules (3) ===');
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
    expect(text).toMatch(/every 2 weeks on \w+, from 2026-01-02/);
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

  it('sorts by the day each one is next due', async () => {
    const text = await listing();
    // Measured here: the engine computes a recurrence's next date forward
    // from today, so none of these is late. Nothing in a fresh budget can
    // be, except a single day that has passed, and that case is in the unit
    // tests for the reason in the note at the top of this file.
    expect(text).not.toContain('due since');
    expect(text.indexOf('Rent')).toBeLessThan(text.indexOf('Insurance'));
  });

  it('reports the transaction a schedule posted, and says so when there is none', async () => {
    const text = await listing();
    expect(text).toContain(`last posted ${PAST}`);
    expect(text).toContain('nothing posted in the last 365 days');
  });

  it('says who posts each one', async () => {
    const text = await listing();
    expect(text).toContain('posts by itself');
    expect(text).toContain('waits to be approved');
  });
});
