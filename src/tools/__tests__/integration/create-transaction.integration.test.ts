import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

// Use the REAL @actual-app/api, but neutralize api.sync(): in local
// (server-less) mode there is nothing to push and it errors. Everything else
// (the engine, rules, transactions) stays real — that is the whole point.
vi.mock('@actual-app/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@actual-app/api')>();
  return { ...actual, sync: vi.fn().mockResolvedValue(undefined) };
});

// Neutralize the connection bootstrap; the harness manages the local engine.
vi.mock('../../../connection.js', () => ({
  ensureConnection: vi.fn().mockResolvedValue(undefined),
}));

import { initTestEngine, shutdownTestEngine, createFreshBudget, api } from './actual-engine.js';
import { createTransaction } from '../../write/create-transaction.js';

const skip = process.env.SKIP_ACTUAL_INTEGRATION === '1';

describe.skipIf(skip)('create_transaction integration (#26)', () => {
  beforeAll(async () => {
    await initTestEngine();
  }, 60_000);

  afterAll(async () => {
    await shutdownTestEngine();
  });

  it('explicit category wins over a learned payee→category mapping', async () => {
    let acctId = '';
    let catXId = '';
    let catYId = '';

    // Seed a budget where payee "Vendor" has been learned as "CatX".
    await createFreshBudget(async () => {
      acctId = await api.createAccount({ name: 'Checking', type: 'checking' } as any, 0);
      const groupId = await api.createCategoryGroup({ name: 'Grp' } as any);
      catXId = await api.createCategory({ name: 'CatX', group_id: groupId } as any);
      catYId = await api.createCategory({ name: 'CatY', group_id: groupId } as any);
      await api.addTransactions(
        acctId,
        [
          { date: '2026-05-01', amount: -100, payee_name: 'Vendor', category: catXId },
          { date: '2026-05-02', amount: -200, payee_name: 'Vendor', category: catXId },
          { date: '2026-05-03', amount: -300, payee_name: 'Vendor', category: catXId },
        ] as any,
        { learnCategories: true, runTransfers: false },
      );
    });

    // Now create a transaction for the same payee but an explicit DIFFERENT category.
    await createTransaction({
      account: 'Checking',
      amount: -9.99,
      payee: 'Vendor',
      category: 'CatY',
      date: '2026-06-05',
    });

    const txns = await api.getTransactions(acctId, '2026-06-05', '2026-06-05');
    const created = txns.find((t) => t.amount === -999);
    expect(created, 'created transaction should exist').toBeTruthy();
    // The explicit category (CatY) must win, NOT the learned one (CatX).
    expect(created!.category).toBe(catYId);
    expect(created!.category).not.toBe(catXId);
  }, 60_000);

  it('persists the explicit category across a budget reload', async () => {
    let acctId = '';
    let catYId = '';
    const budgetId = await createFreshBudget(async () => {
      acctId = await api.createAccount({ name: 'Checking', type: 'checking' } as any, 0);
      const groupId = await api.createCategoryGroup({ name: 'Grp' } as any);
      const catXId = await api.createCategory({ name: 'CatX', group_id: groupId } as any);
      catYId = await api.createCategory({ name: 'CatY', group_id: groupId } as any);
      await api.addTransactions(
        acctId,
        [
          { date: '2026-05-01', amount: -100, payee_name: 'Vendor', category: catXId },
          { date: '2026-05-02', amount: -200, payee_name: 'Vendor', category: catXId },
          { date: '2026-05-03', amount: -300, payee_name: 'Vendor', category: catXId },
        ] as any,
        { learnCategories: true, runTransfers: false },
      );
    });

    await createTransaction({
      account: 'Checking',
      amount: -9.99,
      payee: 'Vendor',
      category: 'CatY',
      date: '2026-06-05',
    });

    await api.loadBudget(budgetId);
    const txns = await api.getTransactions(acctId, '2026-06-05', '2026-06-05');
    const created = txns.find((t) => t.amount === -999);
    expect(created!.category).toBe(catYId);
  }, 60_000);
});
