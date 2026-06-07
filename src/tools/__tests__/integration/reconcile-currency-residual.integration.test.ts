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
});
