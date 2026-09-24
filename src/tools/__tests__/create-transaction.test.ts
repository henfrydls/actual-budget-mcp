import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the external Actual API. addTransactions returns the literal 'ok'
// (matching the real SDK: api/transactions-add -> Promise<'ok'>), NOT an array
// of ids. This is the crux of #26: any logic that expects ids back is dead code.
vi.mock('@actual-app/api', () => ({
  default: {},
  getAccounts: vi.fn().mockResolvedValue([
    { id: 'acc-1', name: 'Checking', closed: false, offbudget: false },
  ]),
  getCategories: vi.fn().mockResolvedValue([
    { id: 'cat-1', name: 'Alimentación', group_id: 'grp-1', hidden: false },
    { id: 'cat-2', name: 'Cashback', group_id: 'grp-2', hidden: false },
  ]),
  getTransactions: vi.fn(),
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

describe('createTransaction (#26 explicit category must win)', () => {
  beforeEach(() => {
    vi.mocked(api.addTransactions).mockClear().mockResolvedValue('ok' as any);
    vi.mocked(api.updateTransaction).mockClear().mockResolvedValue({} as any);
    vi.mocked(api.getTransactions).mockReset();
  });

  it('forces the explicit category when the SDK overrides it with a learned one', async () => {
    // before snapshot: empty; after: the new txn came back with the WRONG (learned) category
    vi.mocked(api.getTransactions)
      .mockResolvedValueOnce([] as any) // before add
      .mockResolvedValueOnce([
        { id: 'txn-new', account: 'acc-1', date: '2026-06-05', amount: -10000, category: 'cat-2' },
      ] as any); // after add — SDK applied a learned category instead of the requested one

    await createTransaction({ account: 'Checking', amount: -100, payee: 'Vendor', category: 'Alimentación', date: '2026-06-05' });

    expect(api.addTransactions).toHaveBeenCalledWith('acc-1', expect.any(Array), {
      learnCategories: false,
      runTransfers: false,
    });
    // The fix: re-find the created txn and force the caller's category
    expect(api.updateTransaction).toHaveBeenCalledOnce();
    // #44: the amount is re-sent so the update can never reset it to 0
    expect(api.updateTransaction).toHaveBeenCalledWith('txn-new', { category: 'cat-1', amount: -10000 });
  });

  it('does not call updateTransaction when the stored category already matches', async () => {
    vi.mocked(api.getTransactions)
      .mockResolvedValueOnce([] as any)
      .mockResolvedValueOnce([
        { id: 'txn-new', account: 'acc-1', date: '2026-06-05', amount: -10000, category: 'cat-1' },
      ] as any); // already correct

    await createTransaction({ account: 'Checking', amount: -100, category: 'Alimentación', date: '2026-06-05' });

    expect(api.updateTransaction).not.toHaveBeenCalled();
  });

  it('still snapshots without a category, but corrects nothing', async () => {
    // The snapshot used to be skipped here, since there was no category to
    // enforce. It is taken every time now: it is also what answers "did the
    // write land?" when the call fails afterwards (#79), and that question
    // does not depend on whether a category was given.
    vi.mocked(api.getTransactions).mockResolvedValue([] as any);

    await createTransaction({ account: 'Checking', amount: -50, date: '2026-06-05' });

    expect(api.addTransactions).toHaveBeenCalledOnce();
    expect(api.getTransactions).toHaveBeenCalled();
    expect(api.updateTransaction).not.toHaveBeenCalled();
  });

  it('only corrects the newly created transaction, not pre-existing ones', async () => {
    vi.mocked(api.getTransactions)
      .mockResolvedValueOnce([
        { id: 'old-1', account: 'acc-1', date: '2026-06-05', amount: -500, category: 'cat-2' },
      ] as any) // before: an existing txn with a different category
      .mockResolvedValueOnce([
        { id: 'old-1', account: 'acc-1', date: '2026-06-05', amount: -500, category: 'cat-2' },
        { id: 'txn-new', account: 'acc-1', date: '2026-06-05', amount: -10000, category: 'cat-2' },
      ] as any);

    await createTransaction({ account: 'Checking', amount: -100, category: 'Alimentación', date: '2026-06-05' });

    expect(api.updateTransaction).toHaveBeenCalledOnce();
    // #44: the amount is re-sent so the update can never reset it to 0
    expect(api.updateTransaction).toHaveBeenCalledWith('txn-new', { category: 'cat-1', amount: -10000 });
  });
});

/**
 * #79: six reported occurrences, from two people using the server daily, where
 * the call returned `We had an unknown problem opening "My-Finances-..."` and
 * the transaction was already in the budget. The error arrives after the write,
 * not instead of it, so it invites the one action that corrupts data.
 */
describe('a write that fails after it has already been applied', () => {
  const failure = () =>
    new Error('We had an unknown problem opening "My-Finances-8174eb5"');

  beforeEach(() => {
    vi.mocked(api.addTransactions).mockReset().mockResolvedValue('ok' as any);
    vi.mocked(api.sync).mockReset().mockResolvedValue(undefined as any);
    vi.mocked(api.getTransactions).mockReset();
    vi.mocked(api.updateTransaction).mockReset().mockResolvedValue({} as any);
  });

  it('does not report a plain failure when the transaction is there', async () => {
    vi.mocked(api.getTransactions)
      .mockResolvedValueOnce([] as any) // before
      .mockResolvedValueOnce([
        { id: 'txn-new', account: 'acc-1', date: '2026-09-21', amount: -5000 },
      ] as any); // after the failure: it landed
    vi.mocked(api.addTransactions).mockRejectedValue(failure());

    await expect(
      createTransaction({ account: 'Checking', amount: -50, date: '2026-09-21' }),
    ).rejects.toThrow(/was saved/i);
  });

  it('tells the caller not to repeat it, which is what duplicates', async () => {
    vi.mocked(api.getTransactions)
      .mockResolvedValueOnce([] as any)
      .mockResolvedValueOnce([
        { id: 'txn-new', account: 'acc-1', date: '2026-09-21', amount: -5000 },
      ] as any);
    vi.mocked(api.addTransactions).mockRejectedValue(failure());

    await expect(
      createTransaction({ account: 'Checking', amount: -50, date: '2026-09-21' }),
    ).rejects.toThrow(/do not repeat it/i);
  });

  it('says a retry is safe when the transaction is genuinely absent', async () => {
    vi.mocked(api.getTransactions).mockResolvedValue([] as any);
    vi.mocked(api.addTransactions).mockRejectedValue(failure());

    await expect(
      createTransaction({ account: 'Checking', amount: -50, date: '2026-09-21' }),
    ).rejects.toThrow(/not saved.*retried safely/is);
  });

  it('does not mistake a different transaction on the same day for this one', async () => {
    // Same account, same date, another amount: not ours, so the write did not
    // land and saying otherwise would stop a legitimate retry.
    vi.mocked(api.getTransactions)
      .mockResolvedValueOnce([] as any)
      .mockResolvedValueOnce([
        { id: 'someone-elses', account: 'acc-1', date: '2026-09-21', amount: -999 },
      ] as any);
    vi.mocked(api.addTransactions).mockRejectedValue(failure());

    await expect(
      createTransaction({ account: 'Checking', amount: -50, date: '2026-09-21' }),
    ).rejects.toThrow(/was not saved/i);
  });

  it('admits it cannot tell when the budget will not open again either', async () => {
    vi.mocked(api.getTransactions)
      .mockResolvedValueOnce([] as any)
      .mockRejectedValueOnce(failure());
    vi.mocked(api.addTransactions).mockRejectedValue(failure());

    await expect(
      createTransaction({ account: 'Checking', amount: -50, date: '2026-09-21' }),
    ).rejects.toThrow(/unknown.*before trying again/is);
  });

  it('covers the sync step too, where the rows are in and the sync is not', async () => {
    vi.mocked(api.getTransactions)
      .mockResolvedValueOnce([] as any)
      .mockResolvedValueOnce([
        { id: 'txn-new', account: 'acc-1', date: '2026-09-21', amount: -5000 },
      ] as any);
    vi.mocked(api.sync).mockRejectedValue(failure());

    await expect(
      createTransaction({ account: 'Checking', amount: -50, date: '2026-09-21' }),
    ).rejects.toThrow(/was saved/i);
  });

  it('leaves an ordinary refusal exactly as it was', async () => {
    vi.mocked(api.getTransactions).mockResolvedValue([] as any);
    vi.mocked(api.addTransactions).mockRejectedValue(new Error('amount is required'));

    await expect(
      createTransaction({ account: 'Checking', amount: -50, date: '2026-09-21' }),
    ).rejects.toThrow('amount is required');
  });
});
