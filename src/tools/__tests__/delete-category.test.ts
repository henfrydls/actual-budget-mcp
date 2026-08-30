import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@actual-app/api', () => ({
  default: {},
  getCategories: vi.fn(),
  getTransactions: vi.fn(),
  getAccounts: vi.fn(),
  deleteCategory: vi.fn(),
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
import { deleteCategoryGuarded } from '../write/delete-category.js';

describe('deleteCategoryGuarded (destructive: budget and rollover are lost)', () => {
  beforeEach(() => {
    vi.mocked(api.getCategories).mockReset().mockResolvedValue([
      { id: 'c1', name: 'Groceries', group_id: 'g1', hidden: false },
    ] as never);
    vi.mocked(api.getAccounts).mockReset().mockResolvedValue([
      { id: 'a1', name: 'Checking', closed: false },
    ] as never);
    vi.mocked(api.getTransactions).mockReset().mockResolvedValue([
      { id: 't1', category: 'c1' },
      { id: 't2', category: 'c1' },
    ] as never);
    vi.mocked(api.deleteCategory).mockReset().mockResolvedValue(undefined as never);
  });

  it('previews on the first call and deletes nothing', async () => {
    const result = await deleteCategoryGuarded({ category: 'Groceries' });

    expect(result.deleted).toBe(false);
    expect(api.deleteCategory).not.toHaveBeenCalled();
  });

  it('warns that budget and rollover history go with it', async () => {
    const result = await deleteCategoryGuarded({ category: 'Groceries' });

    expect(result.lines.join('\n')).toMatch(/budget/i);
    expect(result.lines.join('\n')).toMatch(/rollover/i);
  });

  it('points at transfer_to as the non-destructive path', async () => {
    const result = await deleteCategoryGuarded({ category: 'Groceries' });

    expect(result.lines.join('\n')).toContain('transfer_to');
  });

  it('deletes once confirmed with the exact name', async () => {
    const result = await deleteCategoryGuarded({
      category: 'Groceries',
      confirm: true,
      confirm_name: 'Groceries',
    });

    expect(result.deleted).toBe(true);
    expect(api.deleteCategory).toHaveBeenCalledWith('c1', undefined);
  });

  it('refuses a mismatched name and deletes nothing', async () => {
    await expect(
      deleteCategoryGuarded({ category: 'Groceries', confirm: true, confirm_name: 'Grocerys' }),
    ).rejects.toThrow(/does not match/i);
    expect(api.deleteCategory).not.toHaveBeenCalled();
  });
});
