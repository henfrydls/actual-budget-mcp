import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

vi.mock('@actual-app/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@actual-app/api')>();
  return { ...actual, sync: vi.fn().mockResolvedValue(undefined) };
});

vi.mock('../../../connection.js', () => ({
  ensureConnection: vi.fn().mockResolvedValue(undefined),
}));

import { initTestEngine, shutdownTestEngine, createFreshBudget, api } from './actual-engine.js';
import { updateTransactionFields } from '../../write/update-transaction.js';

const skip = process.env.SKIP_ACTUAL_INTEGRATION === '1';

describe.skipIf(skip)('update_transaction integration (#25)', () => {
  beforeAll(async () => {
    await initTestEngine();
  }, 60_000);

  afterAll(async () => {
    await shutdownTestEngine();
  });

  it('does not zero a split sub-transaction amount when updating without amount', async () => {
    let acctId = '';
    let subId = '';
    const budgetId = await createFreshBudget(async () => {
      acctId = await api.createAccount({ name: 'Checking', type: 'checking' } as any, 0);
      const g = await api.createCategoryGroup({ name: 'G' } as any);
      const c1 = await api.createCategory({ name: 'C1', group_id: g } as any);
      const c2 = await api.createCategory({ name: 'C2', group_id: g } as any);
      await api.addTransactions(
        acctId,
        [
          {
            date: '2026-06-05',
            amount: -4000,
            payee_name: 'Store',
            subtransactions: [
              { amount: -1500, category: c1 },
              { amount: -2500, category: c2 },
            ],
          },
        ] as any,
        { learnCategories: false, runTransfers: false },
      );
    });

    let parent = (await api.getTransactions(acctId, '2026-06-05', '2026-06-05')).find((t: any) => t.is_parent);
    subId = (parent as any).subtransactions[0].id;

    // Update the sub-transaction with notes only — no amount provided (the #25 trigger).
    await updateTransactionFields({ transaction_id: subId, notes: 'partial' });

    await api.loadBudget(budgetId);
    parent = (await api.getTransactions(acctId, '2026-06-05', '2026-06-05')).find((t: any) => t.is_parent);
    const subs = (parent as any).subtransactions;
    const target = subs.find((s: any) => s.id === subId);

    // The amount must be preserved (not reset to 0) and the split total must stay intact.
    expect(target.amount).toBe(-1500);
    expect(subs.reduce((acc: number, s: any) => acc + s.amount, 0)).toBe(-4000);
    expect((parent as any).amount).toBe(-4000);
  }, 60_000);
});
