import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@actual-app/api', () => ({
  default: {},
  getAccounts: vi.fn(),
  getAccountBalance: vi.fn(),
  getTransactions: vi.fn(),
  deleteAccount: vi.fn(),
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
import { deleteAccountGuarded } from '../write/delete-account.js';

describe('deleteAccountGuarded (destructive: needs explicit confirmation)', () => {
  beforeEach(() => {
    vi.mocked(api.getAccounts).mockReset().mockResolvedValue([
      { id: 'a1', name: 'Old Savings', closed: false, offbudget: false },
    ] as any);
    vi.mocked(api.getAccountBalance).mockReset().mockResolvedValue(-2500);
    vi.mocked(api.getTransactions).mockReset().mockResolvedValue([
      { id: 't1' },
      { id: 't2' },
      { id: 't3' },
    ] as any);
    vi.mocked(api.deleteAccount).mockReset().mockResolvedValue(undefined);
    vi.mocked(api.sync).mockClear().mockResolvedValue(undefined);
  });

  it('does not delete on the first call, it previews instead', async () => {
    const result = await deleteAccountGuarded({ account: 'Old Savings' });

    expect(result.deleted).toBe(false);
    expect(api.deleteAccount).not.toHaveBeenCalled();
  });

  it('shows what would be lost: name, balance and transaction count', async () => {
    const result = await deleteAccountGuarded({ account: 'Old Savings' });
    const text = result.lines.join('\n');

    expect(text).toContain('Old Savings');
    expect(text).toContain('3');
    expect(text).toMatch(/25\.00/);
  });

  it('suggests closing the account as the non-destructive alternative', async () => {
    const result = await deleteAccountGuarded({ account: 'Old Savings' });

    expect(result.lines.join('\n')).toMatch(/clos/i);
  });

  it('warns about the side effects Actual cannot undo', async () => {
    // Deleting also unlinks bank sync (not undoable in Actual) and strips the
    // payee/transfer_id from the matching leg in other accounts.
    const text = (await deleteAccountGuarded({ account: 'Old Savings' })).lines.join('\n');

    expect(text).toMatch(/bank sync|unlink/i);
    expect(text).toMatch(/transfer/i);
  });

  it('still refuses with confirm alone, requiring the exact name', async () => {
    const result = await deleteAccountGuarded({ account: 'Old Savings', confirm: true });

    expect(result.deleted).toBe(false);
    expect(api.deleteAccount).not.toHaveBeenCalled();
    expect(result.lines.join('\n')).toMatch(/confirm_name/i);
  });

  it('refuses when the typed name does not match exactly', async () => {
    await expect(
      deleteAccountGuarded({ account: 'Old Savings', confirm: true, confirm_name: 'old savings' }),
    ).rejects.toThrow(/does not match/i);

    expect(api.deleteAccount).not.toHaveBeenCalled();
  });

  it('deletes only with confirm plus the exact name', async () => {
    const result = await deleteAccountGuarded({
      account: 'Old Savings',
      confirm: true,
      confirm_name: 'Old Savings',
    });

    expect(result.deleted).toBe(true);
    expect(api.deleteAccount).toHaveBeenCalledWith('a1');
    expect(api.sync).toHaveBeenCalled();
  });

  it('reports an unknown account clearly', async () => {
    await expect(deleteAccountGuarded({ account: 'Nope' })).rejects.toThrow(/no account/i);
  });

  // api.deleteAccount early-returns for an already-closed account, so claiming
  // success would be a lie — and it unlinks bank sync before that return, which
  // Actual cannot undo.
  it('refuses a closed account instead of reporting a delete that never happens', async () => {
    vi.mocked(api.getAccounts).mockResolvedValue([
      { id: 'closed-1', name: 'Retired Card', closed: true, offbudget: false },
    ] as any);

    await expect(
      deleteAccountGuarded({
        account: 'closed-1',
        confirm: true,
        confirm_name: 'Retired Card',
      }),
    ).rejects.toThrow(/closed/i);

    expect(api.deleteAccount).not.toHaveBeenCalled();
  });
});
