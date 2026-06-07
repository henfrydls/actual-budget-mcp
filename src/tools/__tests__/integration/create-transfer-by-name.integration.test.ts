import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

vi.mock('@actual-app/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@actual-app/api')>();
  return { ...actual, sync: vi.fn().mockResolvedValue(undefined) };
});

vi.mock('../../../connection.js', () => ({
  ensureConnection: vi.fn().mockResolvedValue(undefined),
}));

import { initTestEngine, shutdownTestEngine, createFreshBudget, api } from './actual-engine.js';
import { createTransaction } from '../../write/create-transaction.js';

const skip = process.env.SKIP_ACTUAL_INTEGRATION === '1';

describe.skipIf(skip)('create_transaction transfer linking integration (#24)', () => {
  beforeAll(async () => {
    await initTestEngine();
  }, 60_000);

  afterAll(async () => {
    await shutdownTestEngine();
  });

  it('links both sides when the payee names another account', async () => {
    let aId = '';
    let bId = '';
    const budgetId = await createFreshBudget(async () => {
      aId = await api.createAccount({ name: 'Checking A', type: 'checking' } as any, 0);
      bId = await api.createAccount({ name: 'Savings B', type: 'savings' } as any, 0);
    });

    await createTransaction({
      account: 'Checking A',
      amount: -50,
      payee: 'Savings B',
      date: '2026-06-05',
    });

    await api.loadBudget(budgetId);

    // Both sides exist and balances move in opposite directions.
    expect(await api.getAccountBalance(aId)).toBe(-5000);
    expect(await api.getAccountBalance(bId)).toBe(5000);

    // The counterpart in B is a linked transfer (has transfer_id set).
    const bTxns = await api.getTransactions(bId, '2026-06-05', '2026-06-05');
    expect(bTxns).toHaveLength(1);
    expect((bTxns[0] as any).transfer_id).toBeTruthy();
  }, 60_000);
});
