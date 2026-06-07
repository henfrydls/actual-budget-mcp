import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@actual-app/api', () => ({
  default: {},
  getCategories: vi.fn().mockResolvedValue([
    { id: 'cat-1', name: 'Groceries', group_id: 'g1', hidden: false },
  ]),
  updateTransaction: vi.fn().mockResolvedValue({}),
  sync: vi.fn().mockResolvedValue(undefined),
  runQuery: vi.fn(),
  q: () => ({ filter: () => ({ select: () => ({}) }) }),
  utils: {
    amountToInteger: (amount: number) => Math.round(amount * 100),
    integerToAmount: (cents: number) => cents / 100,
  },
}));

vi.mock('../../connection.js', () => ({
  ensureConnection: vi.fn().mockResolvedValue(undefined),
}));

import * as api from '@actual-app/api';
import { updateTransactionFields } from '../write/update-transaction.js';

describe('updateTransactionFields (#25 split sub-transaction amount)', () => {
  beforeEach(() => {
    vi.mocked(api.updateTransaction).mockClear().mockResolvedValue({} as any);
    vi.mocked(api.runQuery).mockReset();
  });

  it('preserves the current amount when updating a split sub-transaction without amount', async () => {
    vi.mocked(api.runQuery).mockResolvedValue({ data: [{ id: 'sub-1', amount: -1500, is_child: true }] } as any);

    await updateTransactionFields({ transaction_id: 'sub-1', category: 'cat-1' });

    expect(api.updateTransaction).toHaveBeenCalledWith('sub-1', { category: 'cat-1', amount: -1500 });
  });

  it('does not inject an amount for a normal (non-child) transaction', async () => {
    vi.mocked(api.runQuery).mockResolvedValue({ data: [{ id: 't-1', amount: -500, is_child: false }] } as any);

    await updateTransactionFields({ transaction_id: 't-1', notes: 'hi' });

    expect(api.updateTransaction).toHaveBeenCalledWith('t-1', { notes: 'hi' });
  });

  it('uses the provided amount as-is and does not query', async () => {
    await updateTransactionFields({ transaction_id: 'x', amount: -20 });

    expect(api.runQuery).not.toHaveBeenCalled();
    expect(api.updateTransaction).toHaveBeenCalledWith('x', { amount: -2000 });
  });

  it('throws when no fields are provided', async () => {
    await expect(updateTransactionFields({ transaction_id: 'x' })).rejects.toThrow(/no fields/i);
  });
});
