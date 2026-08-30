import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@actual-app/api', () => ({
  default: {},
  getAccounts: vi.fn(),
  getCategories: vi.fn(),
  getPayees: vi.fn(),
  getTransactions: vi.fn(),
  deleteTransaction: vi.fn(),
  sync: vi.fn().mockResolvedValue(undefined),
  utils: {
    amountToInteger: (a: number) => Math.round(a * 100),
    integerToAmount: (c: number) => c / 100,
  },
}));

vi.mock('../../connection.js', () => ({
  ensureConnection: vi.fn().mockResolvedValue(undefined),
}));

import * as api from '@actual-app/api';
import { deleteTransactionGuarded } from '../write/delete-transaction.js';

describe('deleteTransactionGuarded (identified by id: confirm alone is the guard)', () => {
  beforeEach(() => {
    vi.mocked(api.getAccounts).mockReset().mockResolvedValue([
      { id: 'a1', name: 'Checking', closed: false },
    ] as never);
    vi.mocked(api.getCategories).mockReset().mockResolvedValue([
      { id: 'c1', name: 'Groceries', group_id: 'g1' },
    ] as never);
    vi.mocked(api.getPayees).mockReset().mockResolvedValue([
      { id: 'p1', name: 'Supermarket' },
    ] as never);
    vi.mocked(api.getTransactions).mockReset().mockResolvedValue([
      { id: 't1', date: '2026-08-29', amount: -12345, payee: 'p1', category: 'c1' },
    ] as never);
    vi.mocked(api.deleteTransaction).mockReset().mockResolvedValue(undefined as never);
  });

  it('previews on the first call and deletes nothing', async () => {
    const result = await deleteTransactionGuarded({ transaction_id: 't1' });

    expect(result.deleted).toBe(false);
    expect(api.deleteTransaction).not.toHaveBeenCalled();
  });

  it('shows what would be lost: date, amount and payee', async () => {
    const result = await deleteTransactionGuarded({ transaction_id: 't1' });
    const text = result.lines.join('\n');

    expect(text).toContain('2026-08-29');
    expect(text).toContain('Supermarket');
    expect(text).toMatch(/123\.45/);
  });

  it('deletes when confirmed, without requiring a name echo', async () => {
    const result = await deleteTransactionGuarded({ transaction_id: 't1', confirm: true });

    expect(result.deleted).toBe(true);
    expect(api.deleteTransaction).toHaveBeenCalledWith('t1');
  });

  it('warns when the target is a split parent, whose children go too', async () => {
    vi.mocked(api.getTransactions).mockResolvedValue([
      { id: 't1', date: '2026-08-29', amount: -12345, payee: 'p1', is_parent: true },
    ] as never);

    const result = await deleteTransactionGuarded({ transaction_id: 't1' });

    expect(result.lines.join('\n')).toMatch(/split/i);
  });
});
