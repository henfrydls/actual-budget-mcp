import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@actual-app/api', () => ({
  default: {},
  getAccounts: vi.fn().mockResolvedValue([
    { id: 'acc-1', name: 'Card (USD)', closed: false, offbudget: false },
  ]),
  getAccountBalance: vi.fn(),
  getCategories: vi.fn().mockResolvedValue([
    { id: 'cat-1', name: 'Cashback', group_id: 'g1', hidden: false },
  ]),
  getTransactions: vi.fn().mockResolvedValue([]),
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
import { reconcileCurrencyResidual } from '../write/reconcile-currency-residual.js';

describe('reconcileCurrencyResidual (#30)', () => {
  beforeEach(() => {
    vi.mocked(api.addTransactions).mockClear().mockResolvedValue('ok' as any);
    vi.mocked(api.getTransactions).mockReset().mockResolvedValue([] as any);
  });

  it('books an adjustment equal to the delta toward the target balance', async () => {
    // residual debt of -100.00; bank says 0 -> need +100.00 to reach 0
    vi.mocked(api.getAccountBalance).mockResolvedValue(-10000);

    await reconcileCurrencyResidual({ account: 'Card (USD)', target_balance: 0, category: 'Cashback' });

    expect(api.addTransactions).toHaveBeenCalledOnce();
    const [accountId, txns] = vi.mocked(api.addTransactions).mock.calls[0];
    expect(accountId).toBe('acc-1');
    const txn = (txns as any[])[0];
    expect(txn.amount).toBe(10000);
    expect(txn.category).toBe('cat-1');
    expect(txn.notes).toBe('FX residual adjustment');
  });

  it('books a negative adjustment when the balance is above target', async () => {
    vi.mocked(api.getAccountBalance).mockResolvedValue(5000); // +50.00, target 0 -> -50.00
    await reconcileCurrencyResidual({ account: 'Card (USD)', target_balance: 0, category: 'Cashback' });
    const txn = (vi.mocked(api.addTransactions).mock.calls[0][1] as any[])[0];
    expect(txn.amount).toBe(-5000);
  });

  it('respects a non-zero target balance', async () => {
    vi.mocked(api.getAccountBalance).mockResolvedValue(-10000); // -100, target -30 -> +70
    await reconcileCurrencyResidual({ account: 'Card (USD)', target_balance: -30, category: 'Cashback' });
    const txn = (vi.mocked(api.addTransactions).mock.calls[0][1] as any[])[0];
    expect(txn.amount).toBe(7000);
  });

  it('does nothing when the balance already matches the target', async () => {
    vi.mocked(api.getAccountBalance).mockResolvedValue(0);
    const lines = await reconcileCurrencyResidual({ account: 'Card (USD)', target_balance: 0, category: 'Cashback' });
    expect(api.addTransactions).not.toHaveBeenCalled();
    expect(lines.join('\n')).toMatch(/no adjustment/i);
  });

  it('allows a custom adjustment note', async () => {
    vi.mocked(api.getAccountBalance).mockResolvedValue(-10000);
    await reconcileCurrencyResidual({ account: 'Card (USD)', category: 'Cashback', notes: 'Q2 FX cleanup' });
    const txn = (vi.mocked(api.addTransactions).mock.calls[0][1] as any[])[0];
    expect(txn.notes).toBe('Q2 FX cleanup');
  });
});
