import { describe, it, expect, vi, beforeEach } from 'vitest';

const getAccounts = vi.fn();
const getTransactions = vi.fn();
const getCategories = vi.fn();
const getPayees = vi.fn();

vi.mock('@actual-app/api', () => ({
  default: {},
  getAccounts: (...a: unknown[]) => getAccounts(...a),
  getTransactions: (...a: unknown[]) => getTransactions(...a),
  getCategories: (...a: unknown[]) => getCategories(...a),
  getPayees: (...a: unknown[]) => getPayees(...a),
  utils: {
    amountToInteger: (a: number) => Math.round(a * 100),
    integerToAmount: (c: number) => c / 100,
  },
}));

vi.mock('../../connection.js', () => ({
  ensureConnection: vi.fn().mockResolvedValue(undefined),
}));

import { getTransactionsReport } from '../read/get-transactions.js';

beforeEach(() => {
  getAccounts.mockReset().mockResolvedValue([
    { id: 'acc-1', name: 'Checking', closed: false, offbudget: false },
  ]);
  getCategories.mockReset().mockResolvedValue([
    { id: 'cat-1', name: 'Groceries', group_id: 'g1' },
  ]);
  getPayees.mockReset().mockResolvedValue([]);
  getTransactions.mockReset().mockResolvedValue([]);
});

/**
 * The shapes the integration tests cannot produce.
 *
 * A split parent normally never reaches the uncategorized filter, because the
 * loop above replaces it with its parts. One shape does reach it: a parent
 * whose children are gone. That shape was measured rather than imagined —
 * deleting both parts of a real split leaves the parent in place with
 * `is_parent: true` and zero parts, stable across reads — because a fixture
 * for a state the engine cannot produce is fiction, and this file already
 * carries one lesson about that. An audit found the exclusion untested for exactly
 * that reason — removing it broke nothing — and the honest fix is to test the
 * case rather than delete a guard and let the guarantee rest on a different
 * function's behaviour.
 */
describe('a split parent that reaches the filter', () => {
  it('is not offered as work, even with no parts left to expand', async () => {
    getTransactions.mockResolvedValue([
      { id: 'orphan-parent', date: '2026-06-05', amount: -5000, category: null, is_parent: true, subtransactions: [] },
      { id: 'plain', date: '2026-06-05', amount: -100, category: null, notes: 'really unsorted' },
    ]);

    const report = await getTransactionsReport({ uncategorized: true });

    expect(report).toMatch(/really unsorted/);
    expect(report).not.toMatch(/orphan-parent/);
  });
});

describe('a transfer whose counterpart cannot be resolved', () => {
  it('is listed rather than hidden, because hiding it loses it for good', async () => {
    // Without the counterpart the engine's rule cannot be applied. A row shown
    // that needed nothing gets dismissed in a second; a row hidden that needed
    // sorting is never seen again.
    getTransactions.mockResolvedValue([
      { id: 't1', date: '2026-06-05', amount: -100, category: null, transfer_id: 'x', payee: 'unknown-payee', account: 'acc-1', notes: 'unresolvable transfer' },
    ]);

    const report = await getTransactionsReport({ uncategorized: true });

    expect(report).toMatch(/unresolvable transfer/);
  });
});

/**
 * Restored from master. Rewriting this file for #81 deleted these three, which
 * still describe live behaviour: an audit reproduced it by mutating the cleared
 * column and the header and finding nothing failed. They are the difference
 * between a test that no longer describes anything and one that simply was not
 * re-read.
 */
describe('getTransactionsReport (#29 cleared column)', () => {
  beforeEach(() => {
    getAccounts.mockResolvedValue([
      { id: 'a1', name: 'Checking', closed: false, offbudget: false },
    ] as any);
    getCategories.mockResolvedValue([
      { id: 'c1', name: 'Food', group_id: 'g1', hidden: false },
    ] as any);
    getPayees.mockResolvedValue([{ id: 'p1', name: 'Store' }] as any);
    getTransactions.mockResolvedValue([
      { id: 't1', date: '2026-06-05', amount: -1000, account: 'a1', payee: 'p1', category: 'c1', cleared: true },
      { id: 't2', date: '2026-06-04', amount: -2000, account: 'a1', payee: 'p1', category: 'c1', cleared: false },
    ] as any);
  });

  it('renders a Cleared column header', async () => {
    const text = await getTransactionsReport({ start_date: '2026-06-01', end_date: '2026-06-30' });
    expect(text).toContain('Cleared');
  });

  it('marks cleared transactions with ✓ and uncleared with ✗', async () => {
    const text = await getTransactionsReport({ start_date: '2026-06-01', end_date: '2026-06-30' });
    expect(text).toContain('✓');
    expect(text).toContain('✗');
  });

  it('keeps the existing columns and order (backward compatible)', async () => {
    const text = await getTransactionsReport({ start_date: '2026-06-01', end_date: '2026-06-30' });
    for (const col of ['ID', 'Date', 'Payee', 'Category', 'Amount', 'Account', 'Notes']) {
      expect(text).toContain(col);
    }
    // Cleared is appended after Notes, preserving prior field order.
    expect(text.indexOf('Notes')).toBeLessThan(text.indexOf('Cleared'));
  });
});

describe('a payee that looks like a transfer but is not one', () => {
  it('is listed, because nothing was actually transferred', async () => {
    // `addTransactions` without `runTransfers` produces exactly this: a row
    // carrying a transfer payee and a null `transfer_id`. Dropping the
    // `transfer_id` check would hide it whenever both accounts sit on the same
    // side of the budget, and it is an ordinary uncategorised transaction.
    getAccounts.mockResolvedValue([
      { id: 'acc-1', name: 'Checking', closed: false, offbudget: false },
      { id: 'acc-2', name: 'Savings', closed: false, offbudget: false },
    ]);
    getPayees.mockResolvedValue([
      { id: 'p-transfer', name: 'Savings', transfer_acct: 'acc-2' },
    ]);
    getTransactions.mockResolvedValue([
      {
        id: 'looks-like-a-transfer',
        date: '2026-06-05',
        amount: -100,
        category: null,
        payee: 'p-transfer',
        account: 'acc-1',
        transfer_id: null,
        notes: 'NOT-ACTUALLY-A-TRANSFER',
      },
    ]);

    const report = await getTransactionsReport({ uncategorized: true });

    expect(report).toMatch(/NOT-ACTUALLY-A-TRANSFER/);
  });
});
