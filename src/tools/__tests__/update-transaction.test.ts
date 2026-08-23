import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@actual-app/api', () => ({
  default: {},
  getCategories: vi.fn().mockResolvedValue([
    { id: 'cat-1', name: 'Groceries', group_id: 'g1', hidden: false },
  ]),
  getPayees: vi.fn().mockResolvedValue([
    { id: 'payee-1', name: 'Supermarket' },
  ]),
  createPayee: vi.fn().mockResolvedValue('payee-new'),
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

describe('updateTransactionFields (#37 payee must be an id, never payee_name)', () => {
  beforeEach(() => {
    vi.mocked(api.updateTransaction).mockClear().mockResolvedValue({} as any);
    vi.mocked(api.runQuery).mockReset().mockResolvedValue({ data: [{ id: 't-1', amount: -500, is_child: false }] } as any);
    vi.mocked(api.getPayees).mockClear().mockResolvedValue([
      { id: 'payee-1', name: 'Supermarket' },
      // Actual stores transfer payees with an empty name and a transfer_acct.
      { id: 'transfer-payee-1', name: '', transfer_acct: 'acct-1' },
    ] as any);
    vi.mocked(api.createPayee).mockClear().mockResolvedValue('payee-new' as any);
  });

  it('resolves an existing payee name to its id', async () => {
    await updateTransactionFields({ transaction_id: 't-1', payee: 'Supermarket' });

    expect(api.updateTransaction).toHaveBeenCalledWith('t-1', { payee: 'payee-1' });
  });

  it('never sends payee_name, which updateTransaction rejects', async () => {
    await updateTransactionFields({ transaction_id: 't-1', payee: 'Supermarket' });

    const updates = vi.mocked(api.updateTransaction).mock.calls[0][1] as Record<string, unknown>;
    expect(updates).not.toHaveProperty('payee_name');
  });

  it('creates the payee when the name is unknown and uses the new id', async () => {
    await updateTransactionFields({ transaction_id: 't-1', payee: 'Brand New Shop' });

    expect(api.createPayee).toHaveBeenCalledWith({ name: 'Brand New Shop' });
    expect(api.updateTransaction).toHaveBeenCalledWith('t-1', { payee: 'payee-new' });
  });

  // get_transactions output exposes payee ids, so a caller may well pass one
  // back. Treating it as a name would create a junk payee named with the UUID.
  it('accepts a payee id as-is instead of creating a payee named after it', async () => {
    await updateTransactionFields({ transaction_id: 't-1', payee: 'payee-1' });

    expect(api.createPayee).not.toHaveBeenCalled();
    expect(api.updateTransaction).toHaveBeenCalledWith('t-1', { payee: 'payee-1' });
  });

  // A blank name used to match Actual's transfer payees (stored with name ''),
  // silently turning the transaction into a one-sided transfer whose other leg
  // updateTransaction never creates.
  it('refuses a blank payee instead of matching a transfer payee', async () => {
    await expect(
      updateTransactionFields({ transaction_id: 't-1', payee: '  ' }),
    ).rejects.toThrow(/payee/i);

    expect(api.updateTransaction).not.toHaveBeenCalled();
  });
});
