import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

// The real engine, with api.sync() neutralised: there is no server to push to
// in local mode and it errors. Everything else stays real, which is the point.
vi.mock('@actual-app/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@actual-app/api')>();
  return { ...actual, sync: vi.fn().mockResolvedValue(undefined) };
});

// `getInternal` points at the harness engine, so reading the currency goes
// through the engine's own preference handler rather than a stub. That handler
// is the only way to read the synced store, and the whole fix hangs off what it
// answers.
vi.mock('../../../connection.js', async () => {
  const harness = await import('./actual-engine.js');
  return {
    ensureConnection: vi.fn().mockResolvedValue(undefined),
    getInternal: () => harness.testInternal(),
  };
});

import { initTestEngine, shutdownTestEngine, createFreshBudget, api } from './actual-engine.js';
import {
  refreshBudgetDecimalPlaces,
  resetBudgetDecimalPlaces,
  budgetDecimalPlaces,
} from '../../../utils/currency.js';
import { createTransaction, registerCreateTransaction } from '../../write/create-transaction.js';
import { withCurrentCurrency } from '../../../utils/currency.js';
import { getTransactionsReport } from '../../read/get-transactions.js';

const skip = process.env.SKIP_ACTUAL_INTEGRATION === '1';

/**
 * Amounts in a currency with no decimal places (#141).
 *
 * Actual stores an amount as an integer in the currency's smallest unit and
 * converts with that currency's decimal count. This server let both SDK
 * helpers default to two, so in a budget in JPY, KRW or IRR every amount was
 * out by a factor of a hundred in both directions. Measured before the fix, on
 * a budget whose currency is JPY:
 *
 *   asked to spend 100   stored -10000   the app shows ¥-10,000
 *   a real ¥-100 row     stored -100     reported here as -1.00
 *
 * It is not a display problem: the wrong number is what gets written. So the
 * check is on what the engine holds afterwards, not on the reply text, and it
 * runs against the real engine because the default is what a mock would
 * reproduce.
 */
describe.skipIf(skip)('amounts in a currency with no decimal places (#141)', () => {
  beforeAll(async () => {
    await initTestEngine();
  }, 60_000);

  afterAll(async () => {
    await shutdownTestEngine();
    resetBudgetDecimalPlaces();
  });

  /** A fresh budget in `code`, with one on-budget account. */
  async function budgetIn(code: string | undefined): Promise<string> {
    let accountId = '';
    await createFreshBudget(async () => {
      accountId = (await api.createAccount({ name: 'Checking', offbudget: false } as never, 0)) as string;
    });
    if (code) await api.setPreference('defaultCurrencyCode', code);
    await refreshBudgetDecimalPlaces();
    return accountId;
  }

  /** What the engine holds for the account, newest row first. */
  async function storedAmounts(accountId: string): Promise<number[]> {
    // A read straight after a write can answer from before it, so this asks
    // until the row is there rather than once.
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const rows = (await api.getTransactions(accountId, '2000-01-01', '2100-01-01')) as {
        amount: number;
      }[];
      if (rows.length > 0) return rows.map((row) => row.amount);
    }
    return [];
  }

  it('writes a whole yen, not a hundredth of one', async () => {
    const accountId = await budgetIn('JPY');
    expect(budgetDecimalPlaces(), 'the budget currency was not picked up').toBe(0);

    await createTransaction({
      account: 'Checking',
      amount: -100,
      payee: 'Ramen',
      date: '2026-10-12',
    } as never);

    // The number the fix is about. Before it, this was -10000.
    expect(await storedAmounts(accountId)).toEqual([-100]);
  });

  it('reports a yen amount as the figure the app shows', async () => {
    const accountId = await budgetIn('JPY');
    // Written through the engine, as a bank import would arrive: 1,000 yen.
    await api.addTransactions(accountId, [
      { date: '2026-10-12', amount: -1000, payee_name: 'Bookshop', cleared: true } as never,
    ]);

    const text = await getTransactionsReport({ account: 'Checking', limit: 5 } as never);
    // Before the fix this read 10.00, a hundredth of what the app shows.
    expect(text).toContain('1,000');
    expect(text, 'a currency with no decimals should not be printed with any').not.toContain(
      '10.00',
    );
  });

  it('filters by an amount in the same units it stores', async () => {
    // The bounds were converted with a hundred written into the filter, so in
    // a budget in yen they were compared against rows a hundred times
    // smaller: a row of 1,000 did not come back for a floor of 500, and the
    // reply read as if the account held nothing.
    const accountId = await budgetIn('JPY');
    await api.addTransactions(accountId, [
      { date: '2026-10-12', amount: -1000, payee_name: 'Bookshop', cleared: true } as never,
    ]);

    const found = await getTransactionsReport({
      account: 'Checking',
      max_amount: -500,
      limit: 5,
    } as never);
    expect(found).toContain('Bookshop');

    // And the other side of the bound still excludes it.
    const excluded = await getTransactionsReport({
      account: 'Checking',
      min_amount: -500,
      limit: 5,
    } as never);
    expect(excluded).not.toContain('Bookshop');
  });

  it('leaves a two decimal currency exactly as it was', async () => {
    const accountId = await budgetIn('USD');
    expect(budgetDecimalPlaces()).toBe(2);

    await createTransaction({
      account: 'Checking',
      amount: -12.34,
      payee: 'Shop',
      date: '2026-10-12',
    } as never);

    expect(await storedAmounts(accountId)).toEqual([-1234]);
  });

  it('picks up a currency changed while the server is running', async () => {
    // Through the registered tool, which is where the refresh is wrapped, and
    // with nothing calling it by hand. A write converts its amount at the top
    // of the handler and syncs at the end, so a refresh tied to syncing was
    // always one write late: measured, this wrote 10,000 for an amount of 100.
    const accountId = await budgetIn('USD');

    await api.setPreference('defaultCurrencyCode', 'JPY');

    let handler: ((input: unknown) => Promise<unknown>) | undefined;
    registerCreateTransaction(
      withCurrentCurrency({
        tool: (...a: unknown[]) => {
          handler = a.at(-1) as (input: unknown) => Promise<unknown>;
        },
      }) as never,
    );
    await handler!({ account: 'Checking', amount: -100, payee: 'Ramen', date: '2026-10-12' });

    expect(budgetDecimalPlaces(), 'the write did not re-read the currency').toBe(0);
    expect(await storedAmounts(accountId)).toEqual([-100]);
  });

  it('treats a budget with no currency set the way it always did', async () => {
    // Which is every budget whose owner never opened that setting, so this is
    // the path almost everyone is on and it has to be the unchanged one.
    const accountId = await budgetIn(undefined);
    expect(budgetDecimalPlaces()).toBe(2);

    await createTransaction({
      account: 'Checking',
      amount: -12.34,
      payee: 'Shop',
      date: '2026-10-12',
    } as never);

    expect(await storedAmounts(accountId)).toEqual([-1234]);
  });
});
