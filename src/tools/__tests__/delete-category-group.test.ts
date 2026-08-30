import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@actual-app/api', () => ({
  default: {},
  getCategoryGroups: vi.fn(),
  getCategories: vi.fn(),
  deleteCategoryGroup: vi.fn(),
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
import { deleteCategoryGroupGuarded } from '../write/delete-category-group.js';

describe('deleteCategoryGroupGuarded', () => {
  beforeEach(() => {
    vi.mocked(api.getCategoryGroups).mockReset().mockResolvedValue([
      {
        id: 'g1',
        name: 'Fixed Costs',
        categories: [
          { id: 'c1', name: 'Rent' },
          { id: 'c2', name: 'Internet' },
        ],
      },
      { id: 'g2', name: 'Other', categories: [{ id: 'c9', name: 'Misc' }] },
    ] as never);
    vi.mocked(api.getCategories).mockReset().mockResolvedValue([
      { id: 'c1', name: 'Rent', group_id: 'g1' },
      { id: 'c2', name: 'Internet', group_id: 'g1' },
      { id: 'c9', name: 'Misc', group_id: 'g2' },
    ] as never);
    vi.mocked(api.deleteCategoryGroup).mockReset().mockResolvedValue(undefined as never);
  });

  it('previews on the first call and deletes nothing', async () => {
    const result = await deleteCategoryGroupGuarded({ group: 'Fixed Costs', transfer_to: 'Misc' });

    expect(result.deleted).toBe(false);
    expect(api.deleteCategoryGroup).not.toHaveBeenCalled();
  });

  it('names the categories that would be destroyed with the group', async () => {
    const result = await deleteCategoryGroupGuarded({ group: 'Fixed Costs', transfer_to: 'Misc' });
    const text = result.lines.join('\n');

    expect(text).toContain('Rent');
    expect(text).toContain('Internet');
  });

  it('deletes once confirmed with the exact name', async () => {
    const result = await deleteCategoryGroupGuarded({
      group: 'Fixed Costs',
      transfer_to: 'Misc',
      confirm: true,
      confirm_name: 'Fixed Costs',
    });

    expect(result.deleted).toBe(true);
    expect(api.deleteCategoryGroup).toHaveBeenCalledWith('g1', 'c9');
  });

  it('refuses a mismatched name and deletes nothing', async () => {
    await expect(
      deleteCategoryGroupGuarded({
        group: 'Fixed Costs',
        transfer_to: 'Misc',
        confirm: true,
        confirm_name: 'Fixed Cost',
      }),
    ).rejects.toThrow(/does not match/i);
    expect(api.deleteCategoryGroup).not.toHaveBeenCalled();
  });
});
