import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@actual-app/api', () => ({
  default: {},
  getAccounts: vi.fn().mockResolvedValue([
    { id: 'acc-1', name: 'Checking A', closed: false, offbudget: false },
    { id: 'acc-2', name: 'Savings B', closed: false, offbudget: false },
  ]),
  getCategories: vi.fn().mockResolvedValue([
    { id: 'cat-1', name: 'Groceries', group_id: 'g1', hidden: false },
  ]),
  getPayees: vi.fn().mockResolvedValue([
    { id: 'tp-1', name: 'Checking A', transfer_acct: 'acc-1' },
    { id: 'tp-2', name: 'Savings B', transfer_acct: 'acc-2' },
    { id: 'p-1', name: 'Supermarket' },
  ]),
  getTransactions: vi.fn().mockResolvedValue([]),
  addTransactions: vi.fn().mockResolvedValue('ok'),
  updateTransaction: vi.fn().mockResolvedValue({}),
  sync: vi.fn().mockResolvedValue(undefined),
  utils: {
    amountToInteger: (amount: number) => Math.round(amount * 100),
    integerToAmount: (cents: number) => cents / 100,
  },
}));

vi.mock('../../connection.js', () => ({
  ensureConnection: vi.fn().mockResolvedValue(undefined),
}));

import * as api from '@actual-app/api';
import { createTransaction } from '../write/create-transaction.js';

describe('createTransaction transfer linking (#24)', () => {
  beforeEach(() => {
    vi.mocked(api.addTransactions).mockClear().mockResolvedValue('ok' as any);
  });

  it('routes to a linked transfer when the payee names another account', async () => {
    await createTransaction({ account: 'Checking A', amount: -50, payee: 'Savings B', date: '2026-06-05' });

    const [accountId, txns, opts] = vi.mocked(api.addTransactions).mock.calls[0];
    expect(accountId).toBe('acc-1');
    const txn = (txns as any[])[0];
    expect(txn.payee).toBe('tp-2'); // transfer payee for Savings B
    expect(txn.payee_name).toBeUndefined();
    expect(opts).toEqual({ learnCategories: false, runTransfers: true });
  });

  it('uses a regular payee when the payee is not an account', async () => {
    await createTransaction({ account: 'Checking A', amount: -50, payee: 'Supermarket', date: '2026-06-05' });

    const [, txns, opts] = vi.mocked(api.addTransactions).mock.calls[0];
    const txn = (txns as any[])[0];
    expect(txn.payee_name).toBe('Supermarket');
    expect(txn.payee).toBeUndefined();
    expect(opts).toEqual({ learnCategories: false, runTransfers: false });
  });

  it('throws when transferring to the same account', async () => {
    await expect(
      createTransaction({ account: 'Checking A', amount: -50, payee: 'Checking A' }),
    ).rejects.toThrow(/same account/i);
  });

  it('matches the account name case-insensitively', async () => {
    await createTransaction({ account: 'Checking A', amount: -50, payee: 'savings b', date: '2026-06-05' });
    const txn = (vi.mocked(api.addTransactions).mock.calls[0][1] as any[])[0];
    expect(txn.payee).toBe('tp-2');
  });
});
