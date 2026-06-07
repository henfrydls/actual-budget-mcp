import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

// Real @actual-app/api, only api.sync() neutralized (server-less mode).
vi.mock('@actual-app/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@actual-app/api')>();
  return { ...actual, sync: vi.fn().mockResolvedValue(undefined) };
});

vi.mock('../../../connection.js', () => ({
  ensureConnection: vi.fn().mockResolvedValue(undefined),
}));

import { initTestEngine, shutdownTestEngine, createFreshBudget, api } from './actual-engine.js';
import { createSplitTransaction } from '../../write/create-split-transaction.js';

const skip = process.env.SKIP_ACTUAL_INTEGRATION === '1';

describe.skipIf(skip)('create_split_transaction integration (#28)', () => {
  beforeAll(async () => {
    await initTestEngine();
  }, 60_000);

  afterAll(async () => {
    await shutdownTestEngine();
  });

  it('creates a real split with correct parent total and sub-transactions', async () => {
    let acctId = '';
    let c1 = '';
    let c2 = '';
    const budgetId = await createFreshBudget(async () => {
      acctId = await api.createAccount({ name: 'Checking', type: 'checking' } as any, 0);
      const g = await api.createCategoryGroup({ name: 'G' } as any);
      c1 = await api.createCategory({ name: 'Groceries', group_id: g } as any);
      c2 = await api.createCategory({ name: 'Cleaning', group_id: g } as any);
    });

    await createSplitTransaction({
      account: 'Checking',
      amount: -150,
      date: '2026-06-05',
      payee: 'Warehouse Club',
      splits: [
        { category: 'Groceries', amount: -90 },
        { category: 'Cleaning', amount: -60 },
      ],
    });

    // Reload to be sure it persisted, then read back.
    await api.loadBudget(budgetId);
    const txns = await api.getTransactions(acctId, '2026-06-05', '2026-06-05');
    const parent = txns.find((t: any) => t.is_parent);

    expect(parent, 'parent split transaction should exist').toBeTruthy();
    expect((parent as any).amount).toBe(-15000);
    const subs = (parent as any).subtransactions ?? [];
    expect(subs).toHaveLength(2);

    const sum = subs.reduce((acc: number, s: any) => acc + s.amount, 0);
    expect(sum).toBe(-15000);

    const byCat = new Map(subs.map((s: any) => [s.category, s.amount]));
    expect(byCat.get(c1)).toBe(-9000);
    expect(byCat.get(c2)).toBe(-6000);
  }, 60_000);
});
