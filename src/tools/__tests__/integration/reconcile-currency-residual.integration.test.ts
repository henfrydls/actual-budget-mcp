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

  it('does not book a second adjustment when the first one is dated ahead', async () => {
    // getAccountBalance counts `date <= cutoff` and defaults the cutoff to now,
    // so a future-dated adjustment never entered the balance: every run
    // computed the same delta and wrote another one. Two runs left the account
    // at +200 while the balance still read -100.
    let acctId = '';
    const budgetId = await createFreshBudget(async () => {
      acctId = await api.createAccount({ name: 'Card (CHF)', type: 'credit' } as any, 0);
      const g = await api.createCategoryGroup({ name: 'G-CHF' } as any);
      await api.createCategory({ name: 'Cash-CHF', group_id: g } as any);
      await api.addTransactions(
        acctId,
        [{ date: '2026-05-01', amount: -10000, payee_name: 'FX drift' }] as any,
        { learnCategories: false, runTransfers: false },
      );
    });

    const args = {
      account: 'Card (CHF)',
      target_balance: 0,
      category: 'Cash-CHF',
      date: '2027-06-05',
    };
    await reconcileCurrencyResidual(args);
    const second = (await reconcileCurrencyResidual(args)).join('\n');

    expect(second).toMatch(/No adjustment needed/);

    await api.loadBudget(budgetId);
    const all = await api.getTransactions(acctId, '1900-01-01', '2099-12-31');
    expect(all.filter((t: any) => t.amount === 10000)).toHaveLength(1);
    // The true sum of the account, which is what a second adjustment corrupts.
    expect(all.reduce((sum: number, t: any) => sum + t.amount, 0)).toBe(0);
  }, 60_000);

  it('pulls before reading the balance, not merely at some point', async () => {
    // Reconcile computes what it writes from the balance, so a stale balance
    // is a wrong adjustment, not merely a missed warning.
    //
    // Asserting the order, because `createTransaction` syncs too, both before
    // its own check and after its write: "sync was called" is true even with
    // reconcile's own pull deleted, so it cannot fail.
    const { category } = await budgetWithACollision('Card (JPY)');

    const order: string[] = [];
    vi.mocked(api.sync).mockClear().mockImplementation(async () => {
      order.push('sync');
    });
    const balanceSpy = vi
      .spyOn(api, 'getAccountBalance')
      .mockImplementation(async () => {
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
    expect(order[0]).toBe('sync');
    expect(order).toContain('balance');
  }, 60_000);
});
