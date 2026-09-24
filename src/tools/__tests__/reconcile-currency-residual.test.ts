import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fakeQ, lastQuery } from './fake-query.js';

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
  // The write is given an id of our own and found again by querying for it,
  // which is what replaced the date window and the snapshot (#93).
  runQuery: vi.fn().mockResolvedValue({ data: [] }),
  q: (table: string) => fakeQ(table),
  utils: {
    amountToInteger: (amount: number) => Math.round(amount * 100),
    integerToAmount: (cents: number) => cents / 100,
  },
}));

vi.mock('../../connection.js', () => ({
  ensureConnection: vi.fn().mockResolvedValue(undefined),
}));

import * as api from '@actual-app/api';
import {
  reconcileCurrencyResidual,
  registerReconcileCurrencyResidual,
} from '../write/reconcile-currency-residual.js';

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

/**
 * This tool creates its adjustment through createTransaction, so it receives
 * the same verdicts. Both audits found the handler turning "the transaction was
 * saved, do not repeat it" into `isError: true` under a line starting "Error:",
 * which is the contradictory reply the whole change exists to remove.
 */
describe('a verdict arriving from createTransaction', () => {
  it('does not come back as an error when the write was saved', async () => {
    let handler: any;
    registerReconcileCurrencyResidual({
      tool: (...a: unknown[]) => { handler = a.at(-1); },
    } as never);

    vi.mocked(api.getAccountBalance).mockResolvedValue(-10000 as any);
    vi.mocked(api.getTransactions).mockReset().mockResolvedValue([] as any);
    // Found by the marker written with it, not by scanning a date range.
    vi.mocked(api.runQuery).mockReset().mockResolvedValue({ data: [{ id: 'new' }] } as any);
    vi.mocked(api.addTransactions)
      .mockReset()
      .mockRejectedValue(new Error('We had an unknown problem opening "x"'));

    const result = await handler({
      account: 'Card (USD)',
      target_balance: -50,
      category: 'Cashback',
      date: '2026-09-21',
    });

    expect(result.content[0].text).not.toMatch(/^Error:/);
    expect(result.isError).toBeUndefined();
  });
});

describe('reconcile_currency_residual: verdicts other than "saved"', () => {
  it('still reports an unknown outcome as an error', async () => {
    // Only the `applied` path was covered, so exempting every verdict from
    // isError broke nothing.
    let handler: any;
    registerReconcileCurrencyResidual({
      tool: (...a: unknown[]) => { handler = a.at(-1); },
    } as never);

    vi.mocked(api.getAccountBalance).mockResolvedValue(-10000 as any);
    vi.mocked(api.getTransactions).mockReset().mockRejectedValue(new Error('cannot read'));
    vi.mocked(api.runQuery).mockReset().mockResolvedValue({ data: [] } as any);
    vi.mocked(api.addTransactions)
      .mockReset()
      .mockRejectedValue(new Error('We had an unknown problem opening "x"'));

    const result = await handler({
      account: 'Card (USD)',
      target_balance: -50,
      category: 'Cashback',
      date: '2026-09-21',
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/could not be.*determined/is);
  });
});
