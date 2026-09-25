import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

vi.mock('@actual-app/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@actual-app/api')>();
  return { ...actual, sync: vi.fn().mockResolvedValue(undefined) };
});

vi.mock('../../../connection.js', () => ({
  ensureConnection: vi.fn().mockResolvedValue(undefined),
}));

import { initTestEngine, shutdownTestEngine, createFreshBudget, api } from './actual-engine.js';
import { reconcileCurrencyResidual } from '../../write/reconcile-currency-residual.js';

const skip = process.env.SKIP_ACTUAL_INTEGRATION === '1';

describe.skipIf(skip)('reconcile_currency_residual integration (#30)', () => {
  beforeAll(async () => {
    await initTestEngine();
  }, 60_000);

  afterAll(async () => {
    await shutdownTestEngine();
  });

  it('books an adjustment in the given category that brings the account to target', async () => {
    let acctId = '';
    let cashbackId = '';
    const budgetId = await createFreshBudget(async () => {
      acctId = await api.createAccount({ name: 'Card (USD)', type: 'credit' } as any, 0);
      const g = await api.createCategoryGroup({ name: 'G' } as any);
      cashbackId = await api.createCategory({ name: 'Cashback', group_id: g } as any);
      // Accumulated FX residual: account sits at -100.00 while the bank says 0.
      await api.addTransactions(
        acctId,
        [{ date: '2026-05-01', amount: -10000, payee_name: 'FX drift' }] as any,
        { learnCategories: false, runTransfers: false },
      );
    });

    const before = await api.getAccountBalance(acctId);
    expect(before).toBe(-10000);

    await reconcileCurrencyResidual({
      account: 'Card (USD)',
      target_balance: 0,
      category: 'Cashback',
      date: '2026-06-05',
    });

    await api.loadBudget(budgetId);
    const after = await api.getAccountBalance(acctId);
    expect(after).toBe(0);

    // The adjustment must be the +100.00 transaction booked under Cashback.
    const adjustments = await api.getTransactions(acctId, '2026-06-05', '2026-06-05');
    const adjustment = adjustments.find((t: any) => t.amount === 10000);
    expect(adjustment, 'adjustment transaction should exist').toBeTruthy();
    expect((adjustment as any).category).toBe(cashbackId);
  }, 60_000);

  /**
   * Fixture shared by the collision cases: -200 of drift against +100 of
   * unrelated refund leaves the account at -100, so the adjustment is +100,
   * exactly the refund's amount on exactly the refund's day.
   */
  async function budgetWithACollision(name: string) {
    let acctId = '';
    const budgetId = await createFreshBudget(async () => {
      acctId = await api.createAccount({ name, type: 'credit' } as any, 0);
      const g = await api.createCategoryGroup({ name: `G-${name}` } as any);
      await api.createCategory({ name: `Cash-${name}`, group_id: g } as any);
      await api.addTransactions(
        acctId,
        [
          { date: '2026-05-01', amount: -20000, payee_name: 'FX drift' },
          { date: '2026-06-05', amount: 10000, payee_name: 'Unrelated refund' },
        ] as any,
        { learnCategories: false, runTransfers: false },
      );
    });
    return { acctId, budgetId, category: `Cash-${name}` };
  }

  it('does not announce a reconciliation it did not perform', async () => {
    // The whole of the original defect: the header printed regardless, so the
    // reply stated the adjustment, then stated that nothing had been created,
    // then advised a flag the tool did not accept, with the balance unchanged.
    const { acctId, budgetId, category } = await budgetWithACollision('Card (EUR)');

    const text = (
      await reconcileCurrencyResidual({
        account: 'Card (EUR)',
        target_balance: 0,
        category,
        date: '2026-06-05',
      })
    ).join('\n');

    expect(text).not.toMatch(/Currency residual reconciled/);
    expect(text).toMatch(/No adjustment was booked/);
    expect(text).toMatch(/allow_duplicate/);

    await api.loadBudget(budgetId);
    // Refused means refused: the balance is untouched and no third row exists.
    expect(await api.getAccountBalance(acctId)).toBe(-10000);
    expect((await api.getTransactions(acctId, '2026-06-05', '2026-06-05')).length).toBe(1);
  }, 60_000);

  it('books the adjustment when the caller says the match is not it', async () => {
    const { acctId, budgetId, category } = await budgetWithACollision('Card (GBP)');

    const text = (
      await reconcileCurrencyResidual({
        account: 'Card (GBP)',
        target_balance: 0,
        category,
        date: '2026-06-05',
        allow_duplicate: true,
      })
    ).join('\n');

    expect(text).toMatch(/Currency residual reconciled/);

    await api.loadBudget(budgetId);
    expect(await api.getAccountBalance(acctId)).toBe(0);
    expect((await api.getTransactions(acctId, '2026-06-05', '2026-06-05')).length).toBe(2);
  }, 60_000);

  it('refuses a future date rather than booking something that cannot reconcile', async () => {
    // Measured, both ways round, before this became a refusal: the balance
    // counts `date <= today`, so an adjustment dated ahead never entered it.
    // Two runs at the same future date wrote two adjustments; and moving the
    // cutoff to the adjustment's own date instead made `Was:` disagree with
    // the bank statement and still left a second run with no date free to book
    // again.
    let acctId = '';
    await createFreshBudget(async () => {
      acctId = await api.createAccount({ name: 'Card (CHF)', type: 'credit' } as any, 0);
      const g = await api.createCategoryGroup({ name: 'G-CHF' } as any);
      await api.createCategory({ name: 'Cash-CHF', group_id: g } as any);
      await api.addTransactions(
        acctId,
        [{ date: '2026-05-01', amount: -10000, payee_name: 'FX drift' }] as any,
        { learnCategories: false, runTransfers: false },
      );
    });

    await expect(
      reconcileCurrencyResidual({
        account: 'Card (CHF)',
        target_balance: 0,
        category: 'Cash-CHF',
        date: '2027-06-05',
      }),
    ).rejects.toThrow(/2027-06-05.*in the future/s);

    // Refused means nothing written.
    expect(await api.getTransactions(acctId, '1900-01-01', '2099-12-31')).toHaveLength(1);
  }, 60_000);

  it('reports the balance the bank would report, not one as of some other day', async () => {
    // A pre-existing future row must not move the figure the user compares
    // against their statement. The cutoff that briefly lived here made this
    // say -150.00 where the bank says -100.00, and book +150.00.
    let acctId = '';
    await createFreshBudget(async () => {
      acctId = await api.createAccount({ name: 'Card (NOK)', type: 'credit' } as any, 0);
      const g = await api.createCategoryGroup({ name: 'G-NOK' } as any);
      await api.createCategory({ name: 'Cash-NOK', group_id: g } as any);
      await api.addTransactions(
        acctId,
        [
          { date: '2026-05-01', amount: -10000, payee_name: 'FX drift' },
          { date: '2099-01-01', amount: -5000, payee_name: 'Scheduled, far ahead' },
        ] as any,
        { learnCategories: false, runTransfers: false },
      );
    });

    const text = (
      await reconcileCurrencyResidual({
        account: 'Card (NOK)',
        target_balance: 0,
        category: 'Cash-NOK',
      })
    ).join('\n');

    expect(text).toContain('Was:        -100.00');
    expect(text).toContain('Adjustment: 100.00');
    // And it agrees with what the SDK reports for the account today.
    expect(await api.getAccountBalance(acctId)).toBe(0);
  }, 60_000);

  it('stops by itself on a second run at the same date', async () => {
    // The guarantee that replaced the cutoff: once the adjustment is in, the
    // balance equals the target and the second run never reaches the write.
    let acctId = '';
    await createFreshBudget(async () => {
      acctId = await api.createAccount({ name: 'Card (SEK)', type: 'credit' } as any, 0);
      const g = await api.createCategoryGroup({ name: 'G-SEK' } as any);
      await api.createCategory({ name: 'Cash-SEK', group_id: g } as any);
      await api.addTransactions(
        acctId,
        [{ date: '2026-05-01', amount: -10000, payee_name: 'FX drift' }] as any,
        { learnCategories: false, runTransfers: false },
      );
    });

    const args = { account: 'Card (SEK)', target_balance: 0, category: 'Cash-SEK' };
    await reconcileCurrencyResidual(args);
    const second = (await reconcileCurrencyResidual(args)).join('\n');

    expect(second).toMatch(/No adjustment needed/);
    const all = await api.getTransactions(acctId, '1900-01-01', '2099-12-31');
    expect(all.filter((t: any) => t.amount === 10000)).toHaveLength(1);
  }, 60_000);

  it('waits for the pull to finish before reading the balance', async () => {
    // Reconcile computes what it writes from the balance, so a stale balance
    // is a wrong adjustment, not merely a missed warning.
    //
    // Start AND finish, not just which call came first. A promise started and
    // not awaited still gets its call in first, so `void pullBeforeReading()`
    // satisfied an order-of-start check while the balance was read against the
    // copy the pull was meant to refresh. That is the same hole this round
    // closed in the util and then reproduced here.
    const { category } = await budgetWithACollision('Card (JPY)');

    const order: string[] = [];
    vi.mocked(api.sync).mockClear().mockImplementation(async () => {
      order.push('sync:start');
      await Promise.resolve();
      await Promise.resolve();
      order.push('sync:done');
    });
    const balanceSpy = vi.spyOn(api, 'getAccountBalance').mockImplementation(async () => {
      order.push('balance');
      return -10000;
    });

    await reconcileCurrencyResidual({
      account: 'Card (JPY)',
      target_balance: 0,
      category,
      date: '2026-06-07',
    });

    balanceSpy.mockRestore();
    expect(order.slice(0, 3)).toEqual(['sync:start', 'sync:done', 'balance']);
  }, 60_000);
});
