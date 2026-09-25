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
 * whose children are gone. An audit found the exclusion untested for exactly
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
