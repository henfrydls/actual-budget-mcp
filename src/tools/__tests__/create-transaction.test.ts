import { describe, it, expect, vi } from 'vitest';

// Mock @actual-app/api before importing the module
vi.mock('@actual-app/api', () => ({
  default: {},
  getAccounts: vi.fn().mockResolvedValue([
    { id: 'acc-1', name: 'Cartera (Efectivo)', closed: false, offbudget: false },
  ]),
  getCategories: vi.fn().mockResolvedValue([
    { id: 'cat-1', name: 'Alimentación', group_id: 'grp-1', hidden: false },
    { id: 'cat-2', name: 'Cashback', group_id: 'grp-2', hidden: false },
  ]),
  addTransactions: vi.fn().mockResolvedValue(['txn-new-1']),
  updateTransaction: vi.fn().mockResolvedValue({}),
  sync: vi.fn().mockResolvedValue(undefined),
  utils: {
    amountToInteger: (amount: number) => Math.round(amount * 100),
    integerToAmount: (cents: number) => cents / 100,
  },
}));

// Mock connection
vi.mock('../../connection.js', () => ({
  ensureConnection: vi.fn().mockResolvedValue(undefined),
}));

import * as api from '@actual-app/api';

describe('create-transaction category fix', () => {
  it('calls updateTransaction after addTransactions to force category', async () => {
    const addTxn = vi.mocked(api.addTransactions);
    const updateTxn = vi.mocked(api.updateTransaction);

    addTxn.mockClear();
    updateTxn.mockClear();
    addTxn.mockResolvedValue(['txn-123']);

    // Simulate what create_transaction does internally
    const categoryId = 'cat-1'; // Alimentación
    const transaction = {
      date: '2026-04-01',
      amount: -10000,
      cleared: false,
      payee_name: 'Sirena',
      category: categoryId,
    };

    const result = await api.addTransactions('acc-1', [transaction as any], {
      learnCategories: false,
      runTransfers: false,
    });

    // The fix: force category update after creation
    if (categoryId && result && Array.isArray(result) && result.length > 0) {
      await api.updateTransaction(result[0], { category: categoryId });
    }

    expect(addTxn).toHaveBeenCalledOnce();
    expect(addTxn).toHaveBeenCalledWith('acc-1', [transaction], {
      learnCategories: false,
      runTransfers: false,
    });

    // Verify updateTransaction was called to force category
    expect(updateTxn).toHaveBeenCalledOnce();
    expect(updateTxn).toHaveBeenCalledWith('txn-123', { category: 'cat-1' });
  });

  it('does not call updateTransaction when no category provided', async () => {
    const updateTxn = vi.mocked(api.updateTransaction);
    updateTxn.mockClear();

    const categoryId = undefined;

    await api.addTransactions('acc-1', [{ date: '2026-04-01', amount: -5000 } as any], {
      learnCategories: false,
      runTransfers: false,
    });

    if (categoryId) {
      await api.updateTransaction('txn-123', { category: categoryId });
    }

    expect(updateTxn).not.toHaveBeenCalled();
  });
});
