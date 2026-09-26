import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fakeQ, lastQuery } from './fake-query.js';

vi.mock('@actual-app/api', () => ({
  default: {},
  getAccounts: vi.fn(),
  getCategories: vi.fn(),
  getPayees: vi.fn(),
  // The row is found by its id now, not by scanning accounts over a date
  // window: that window hid four kinds of row that exist (#103).
  runQuery: vi.fn(),
  q: (table: string) => fakeQ(table),
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
import { deleteTransactionGuarded, registerDeleteTransaction } from '../write/delete-transaction.js';

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
    vi.mocked(api.getTransactions).mockReset().mockResolvedValue([] as never);
    vi.mocked(api.runQuery).mockReset().mockResolvedValue({
      data: [{ id: 't1', date: '2026-08-29', amount: -12345, payee: 'p1', category: 'c1', account: 'a1' }],
    } as never);
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
    vi.mocked(api.runQuery).mockResolvedValue({
      data: [{ id: 't1', date: '2026-08-29', amount: -12345, payee: 'p1', account: 'a1', is_parent: true }],
    } as never);

    const result = await deleteTransactionGuarded({ transaction_id: 't1' });

    expect(result.lines.join('\n')).toMatch(/split/i);
  });
});

/**
 * #103. The preview is the whole of this tool's guard, and it was blank for
 * four kinds of row that exist, while the delete went through on confirm. Not
 * refusing: asking the caller to confirm a blank.
 */
describe('delete_transaction: finding the row it is about to destroy', () => {
  beforeEach(() => {
    vi.mocked(api.getAccounts).mockReset().mockResolvedValue([
      { id: 'a1', name: 'Checking', closed: false },
      { id: 'a2', name: 'Old Card', closed: true },
    ] as never);
    vi.mocked(api.getCategories).mockReset().mockResolvedValue([] as never);
    vi.mocked(api.getPayees).mockReset().mockResolvedValue([] as never);
    vi.mocked(api.deleteTransaction).mockReset().mockResolvedValue(undefined as never);
    vi.mocked(api.runQuery).mockReset().mockResolvedValue({ data: [] } as never);
  });

  it('asks for the row by id, with no date window and no account filter', async () => {
    await deleteTransactionGuarded({ transaction_id: 't1' });

    expect(lastQuery.filter).toEqual({ id: 't1' });
    // `grouped`, which is what getTransactions fixes internally, nests a split
    // child inside its parent and leaves no row to match on.
    expect(lastQuery.options).toEqual({ splits: 'all' });
  });

  it('refuses an id that matches nothing, and deletes nothing even when confirmed', async () => {
    // It used to report "Transaction <id> deleted." for an id that never
    // existed, which is the one answer that hides an already-deleted row.
    const result = await deleteTransactionGuarded({ transaction_id: 'ghost', confirm: true });

    expect(result.deleted).toBe(false);
    expect(result.lines.join('\n')).toMatch(/No transaction with id ghost exists/);
    expect(api.deleteTransaction).not.toHaveBeenCalled();
  });

  it('previews a row in a closed account, and says the account is closed', async () => {
    vi.mocked(api.runQuery).mockResolvedValue({
      data: [{ id: 't9', date: '2026-06-07', amount: -900, account: 'a2' }],
    } as never);

    const text = (await deleteTransactionGuarded({ transaction_id: 't9' })).lines.join('\n');

    expect(text).toContain('2026-06-07');
    expect(text).toContain('Old Card');
    expect(text).toMatch(/closed/i);
    expect(text).not.toMatch(/not found/i);
  });

  it('says when the target is one part of a split, not the purchase', async () => {
    // The amount shown is a share. Deleting it leaves the rest of the split
    // behind, which is a different outcome from deleting the purchase.
    vi.mocked(api.runQuery).mockResolvedValue({
      data: [{ id: 'c1', date: '2026-06-05', amount: -4000, account: 'a1', is_child: true }],
    } as never);

    const text = (await deleteTransactionGuarded({ transaction_id: 'c1' })).lines.join('\n');

    expect(text).toMatch(/one part of a split/i);
    expect(text).toMatch(/moves the account balance by 40\.00/);
    expect(text).toMatch(/parts no longer add up to/);
  });

  it('reports a missing row as an error through the handler, not as a result', async () => {
    let handler: any;
    registerDeleteTransaction({ tool: (...a: unknown[]) => { handler = a.at(-1); } } as never);

    const res = await handler({ transaction_id: 'ghost', confirm: true });

    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/No transaction with id ghost exists/);
  });
});
