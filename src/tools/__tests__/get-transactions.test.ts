import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@actual-app/api', () => ({
  default: {},
  getAccounts: vi.fn(),
  getCategories: vi.fn(),
  getPayees: vi.fn(),
  getTransactions: vi.fn(),
  utils: {
    amountToInteger: (amount: number) => Math.round(amount * 100),
    integerToAmount: (cents: number) => cents / 100,
  },
}));

vi.mock('../../connection.js', () => ({
  ensureConnection: vi.fn().mockResolvedValue(undefined),
}));

import * as api from '@actual-app/api';
import { getTransactionsReport } from '../read/get-transactions.js';

describe('getTransactionsReport (#29 cleared column)', () => {
  beforeEach(() => {
    vi.mocked(api.getAccounts).mockResolvedValue([
      { id: 'a1', name: 'Checking', closed: false, offbudget: false },
    ] as any);
    vi.mocked(api.getCategories).mockResolvedValue([
      { id: 'c1', name: 'Food', group_id: 'g1', hidden: false },
    ] as any);
    vi.mocked(api.getPayees).mockResolvedValue([{ id: 'p1', name: 'Store' }] as any);
    vi.mocked(api.getTransactions).mockResolvedValue([
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
