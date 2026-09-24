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
import { createTransaction, registerCreateTransaction } from '../write/create-transaction.js';

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

  it('says a retry is safe only when nothing new appeared at all', async () => {
    vi.mocked(api.getTransactions).mockResolvedValue([] as any);
    vi.mocked(api.addTransactions).mockRejectedValue(failure());

    await expect(
      createTransaction({ account: 'Checking', amount: -50, date: '2026-09-21' }),
    ).rejects.toThrow(/not saved.*can be retried/is);
  });

  it('will not say "not saved" when something unrecognised did appear', async () => {
    // An earlier version answered "not saved, safe to retry" here, reasoning
    // that a row with a different amount is not ours. Actual runs rules on
    // every insert and a rule can rewrite the amount or the date, so this row
    // may well be ours, rewritten. "Not saved" would authorise the retry that
    // duplicates, which is worse than the plain error this replaced.
    vi.mocked(api.getTransactions)
      .mockResolvedValueOnce([] as any)
      .mockResolvedValueOnce([
        { id: 'unrecognised', account: 'acc-1', date: '2026-09-21', amount: -999 },
      ] as any);
    vi.mocked(api.addTransactions).mockRejectedValue(failure());

    await expect(
      createTransaction({ account: 'Checking', amount: -50, date: '2026-09-21' }),
    ).rejects.toThrow(/could not be.*determined/is);
  });

  it('will not pick one of two identical-looking rows and call it ours', async () => {
    // Two agents reconciling the same statement produce the same amount on the
    // same day in the same account. Guessing which row is ours would say "do
    // not repeat it" about a transaction the user never got.
    vi.mocked(api.getTransactions)
      .mockResolvedValueOnce([] as any)
      .mockResolvedValueOnce([
        { id: 'a', account: 'acc-1', date: '2026-09-21', amount: -5000 },
        { id: 'b', account: 'acc-1', date: '2026-09-21', amount: -5000 },
      ] as any);
    vi.mocked(api.addTransactions).mockRejectedValue(failure());

    await expect(
      createTransaction({ account: 'Checking', amount: -50, date: '2026-09-21' }),
    ).rejects.toThrow(/could not be.*determined/is);
  });

  it('admits it cannot tell when the budget will not open again either', async () => {
    vi.mocked(api.getTransactions)
      .mockResolvedValueOnce([] as any)
      .mockRejectedValueOnce(failure());
    vi.mocked(api.addTransactions).mockRejectedValue(failure());

    await expect(
      createTransaction({ account: 'Checking', amount: -50, date: '2026-09-21' }),
    ).rejects.toThrow(/could not be.*determined/is);
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

describe('when the check itself cannot run', () => {
  const failure = () => new Error('We had an unknown problem opening "My-Finances-8174eb5"');

  it('still writes when the snapshot fails, and says the outcome is unknown', async () => {
    // A diagnostic must not block the operation it was added to describe.
    vi.mocked(api.getTransactions).mockReset().mockRejectedValue(new Error('read failed'));
    vi.mocked(api.addTransactions).mockReset().mockResolvedValue('ok' as any);
    vi.mocked(api.sync).mockReset().mockResolvedValue(undefined as any);

    const lines = await createTransaction({ account: 'Checking', amount: -50, date: '2026-09-21' });

    expect(api.addTransactions).toHaveBeenCalledOnce();
    expect(lines.join('\n')).toMatch(/Transaction created/);
  });

  it('reports unknown rather than guessing when there is no baseline', async () => {
    vi.mocked(api.getTransactions)
      .mockReset()
      .mockRejectedValueOnce(new Error('read failed'))
      .mockResolvedValue([{ id: 'x', account: 'acc-1', date: '2026-09-21', amount: -5000 }] as any);
    vi.mocked(api.addTransactions).mockReset().mockRejectedValue(failure());

    await expect(
      createTransaction({ account: 'Checking', amount: -50, date: '2026-09-21' }),
    ).rejects.toThrow(/could not be.*determined/is);
  });
});

/**
 * The probe window is for answering "did it land?" after a failure. Reusing it
 * for the category diff widened that diff from one day to sixty-two, and every
 * mutation schedules a full sync a second later, so rows written by another
 * process land inside the gap and were given this transaction's category.
 * Silent, on the success path, and invisible in a reconciliation.
 */
describe('forcing the category never touches another row', () => {
  it('leaves a row from another day alone, even inside the probe window', async () => {
    vi.mocked(api.getTransactions)
      .mockReset()
      .mockResolvedValueOnce([] as any)
      .mockResolvedValueOnce([
        { id: 'mine', account: 'acc-1', date: '2026-09-21', amount: -5000, category: null },
        // Arrived between the two reads, from someone else's write.
        { id: 'theirs', account: 'acc-1', date: '2026-09-07', amount: -31900, category: 'cat-2' },
      ] as any);
    vi.mocked(api.addTransactions).mockReset().mockResolvedValue('ok' as any);
    vi.mocked(api.sync).mockReset().mockResolvedValue(undefined as any);
    vi.mocked(api.updateTransaction).mockReset().mockResolvedValue({} as any);

    await createTransaction({
      account: 'Checking',
      amount: -50,
      date: '2026-09-21',
      category: 'Alimentación',
    });

    const touched = vi.mocked(api.updateTransaction).mock.calls.map((c) => c[0]);
    expect(touched).toEqual(['mine']);
    expect(touched).not.toContain('theirs');
  });
});

/**
 * Through the registered handler, not the inner function: the promise that a
 * saved write is not reported as an error lives in the handler, and mutating
 * all three handlers to ignore it used to break exactly one test.
 */
describe('create_transaction through its handler', () => {
  const capture = () => {
    let handler: any;
    registerCreateTransaction({ tool: (...a: unknown[]) => { handler = a.at(-1); } } as never);
    return handler as (input: Record<string, unknown>) => Promise<any>;
  };

  it('does not report a saved write as an error', async () => {
    vi.mocked(api.getTransactions)
      .mockReset()
      .mockResolvedValueOnce([] as any)
      .mockResolvedValueOnce([
        { id: 'new', account: 'acc-1', date: '2026-09-21', amount: -5000, cleared: false },
      ] as any);
    vi.mocked(api.addTransactions)
      .mockReset()
      .mockRejectedValue(new Error('We had an unknown problem opening "x"'));

    const result = await capture()({ account: 'Checking', amount: -50, date: '2026-09-21' });

    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toMatch(/was saved/i);
    expect(result.content[0].text).not.toMatch(/^Error:/);
  });

  it('still reports an unknown outcome as an error', async () => {
    vi.mocked(api.getTransactions)
      .mockReset()
      .mockResolvedValueOnce([] as any)
      .mockResolvedValueOnce([
        { id: 'stranger', account: 'acc-1', date: '2026-09-21', amount: -777 },
      ] as any);
    vi.mocked(api.addTransactions)
      .mockReset()
      .mockRejectedValue(new Error('We had an unknown problem opening "x"'));

    const result = await capture()({ account: 'Checking', amount: -50, date: '2026-09-21' });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/could not be.*determined/is);
  });
});
