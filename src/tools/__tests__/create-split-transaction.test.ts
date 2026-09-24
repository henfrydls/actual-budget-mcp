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
  // Read twice now: once before the write and once after a failure, to
  // answer whether the split landed (#79).
  getTransactions: vi.fn().mockResolvedValue([]),
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

/**
 * #79 for splits. Repeating one duplicates a parent and every child under it,
 * so a failure that cannot say whether the write landed is worse here than
 * anywhere else.
 */
describe('a split that fails after it has already been applied', () => {
  const failure = () =>
    new Error('We had an unknown problem opening "My-Finances-8174eb5"');

  const split = () =>
    createSplitTransaction({
      account: 'Checking',
      amount: -100,
      date: '2026-09-21',
      splits: [
        { amount: -60, category: 'Groceries' },
        { amount: -40, category: 'Cleaning' },
      ],
    });

  beforeEach(() => {
    vi.mocked(api.addTransactions).mockReset().mockResolvedValue('ok' as any);
    vi.mocked(api.sync).mockReset().mockResolvedValue(undefined as any);
    vi.mocked(api.getTransactions).mockReset().mockResolvedValue([] as any);
  });

  it('does not report a plain failure when the split is there', async () => {
    vi.mocked(api.getTransactions)
      .mockResolvedValueOnce([] as any)
      .mockResolvedValueOnce([
        { id: 'parent-new', account: 'acc-1', date: '2026-09-21', amount: -10000 },
      ] as any);
    vi.mocked(api.addTransactions).mockRejectedValue(failure());

    await expect(split()).rejects.toThrow(/was saved.*do not repeat it/is);
  });

  it('says a retry is safe when it is genuinely absent', async () => {
    vi.mocked(api.addTransactions).mockRejectedValue(failure());

    await expect(split()).rejects.toThrow(/was not saved.*retried safely/is);
  });

  it('leaves an ordinary refusal exactly as it was', async () => {
    vi.mocked(api.addTransactions).mockRejectedValue(new Error('splits must sum to the total'));

    await expect(split()).rejects.toThrow('splits must sum to the total');
  });
});
