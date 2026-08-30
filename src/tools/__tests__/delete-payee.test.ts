import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@actual-app/api', () => ({
  default: {},
  getPayees: vi.fn(),
  getAccounts: vi.fn(),
  getTransactions: vi.fn(),
  deletePayee: vi.fn(),
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
import { deletePayeeGuarded } from '../write/delete-payee.js';

describe('deletePayeeGuarded', () => {
  beforeEach(() => {
    vi.mocked(api.getPayees).mockReset().mockResolvedValue([
      { id: 'p1', name: 'Supermarket' },
    ] as never);
    vi.mocked(api.getAccounts).mockReset().mockResolvedValue([
      { id: 'a1', name: 'Checking', closed: false },
    ] as never);
    vi.mocked(api.getTransactions).mockReset().mockResolvedValue([
      { id: 't1', payee: 'p1' },
      { id: 't2', payee: 'p1' },
      { id: 't3', payee: 'other' },
    ] as never);
    vi.mocked(api.deletePayee).mockReset().mockResolvedValue(undefined as never);
  });

  it('previews on the first call and deletes nothing', async () => {
    const result = await deletePayeeGuarded({ payee: 'Supermarket' });

    expect(result.deleted).toBe(false);
    expect(api.deletePayee).not.toHaveBeenCalled();
  });

  it('reports how many transactions reference the payee', async () => {
    const result = await deletePayeeGuarded({ payee: 'Supermarket' });

    expect(result.lines.join('\n')).toContain('2');
  });

  it('deletes once confirmed with the exact name', async () => {
    const result = await deletePayeeGuarded({
      payee: 'Supermarket',
      confirm: true,
      confirm_name: 'Supermarket',
    });

    expect(result.deleted).toBe(true);
    expect(api.deletePayee).toHaveBeenCalledWith('p1');
  });

  it('refuses a mismatched name and deletes nothing', async () => {
    await expect(
      deletePayeeGuarded({ payee: 'Supermarket', confirm: true, confirm_name: 'Supermarkt' }),
    ).rejects.toThrow(/does not match/i);
    expect(api.deletePayee).not.toHaveBeenCalled();
  });
});
