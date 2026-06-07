import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@actual-app/api', () => ({
  default: {},
  getAccounts: vi.fn().mockResolvedValue([
    { id: 'acc-1', name: 'Checking', closed: false, offbudget: false },
  ]),
  getCategories: vi.fn().mockResolvedValue([
    { id: 'cat-1', name: 'Groceries', group_id: 'g1', hidden: false },
    { id: 'cat-2', name: 'Cleaning', group_id: 'g1', hidden: false },
    { id: 'cat-3', name: 'Electronics', group_id: 'g1', hidden: false },
  ]),
  addTransactions: vi.fn().mockResolvedValue('ok'),
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
import { createSplitTransaction } from '../write/create-split-transaction.js';

describe('createSplitTransaction (#28)', () => {
  beforeEach(() => {
    vi.mocked(api.addTransactions).mockClear().mockResolvedValue('ok' as any);
  });

  it('creates a parent with subtransactions when splits sum to the total', async () => {
    await createSplitTransaction({
      account: 'Checking',
      amount: -150,
      date: '2026-06-05',
      payee: 'Warehouse Club',
      splits: [
        { category: 'Groceries', amount: -90 },
        { category: 'Cleaning', amount: -40 },
        { category: 'Electronics', amount: -20 },
      ],
    });

    expect(api.addTransactions).toHaveBeenCalledOnce();
    const [accountId, txns, opts] = vi.mocked(api.addTransactions).mock.calls[0];
    expect(accountId).toBe('acc-1');
    expect(opts).toEqual({ learnCategories: false, runTransfers: false });
    const parent = (txns as any[])[0];
    expect(parent.amount).toBe(-15000);
    expect(parent.payee_name).toBe('Warehouse Club');
    expect(parent.subtransactions).toEqual([
      { amount: -9000, category: 'cat-1' },
      { amount: -4000, category: 'cat-2' },
      { amount: -2000, category: 'cat-3' },
    ]);
  });

  it('rejects when the splits do not sum to the total amount', async () => {
    await expect(
      createSplitTransaction({
        account: 'Checking',
        amount: -150,
        splits: [
          { category: 'Groceries', amount: -90 },
          { category: 'Cleaning', amount: -40 },
        ],
      }),
    ).rejects.toThrow(/sum/i);
    expect(api.addTransactions).not.toHaveBeenCalled();
  });

  it('requires at least two splits', async () => {
    await expect(
      createSplitTransaction({
        account: 'Checking',
        amount: -90,
        splits: [{ category: 'Groceries', amount: -90 }],
      }),
    ).rejects.toThrow(/at least two|two splits/i);
  });

  it('carries per-split notes when provided', async () => {
    await createSplitTransaction({
      account: 'Checking',
      amount: -100,
      splits: [
        { category: 'Groceries', amount: -60, notes: 'food' },
        { category: 'Cleaning', amount: -40 },
      ],
    });
    const parent = vi.mocked(api.addTransactions).mock.calls[0][1][0] as any;
    expect(parent.subtransactions[0]).toEqual({ amount: -6000, category: 'cat-1', notes: 'food' });
    expect(parent.subtransactions[1]).toEqual({ amount: -4000, category: 'cat-2' });
  });
});
