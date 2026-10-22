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

/**
 * A group with nothing in it (#266).
 *
 * `transfer_to` is where the transactions of the deleted categories go. An
 * empty group has none, so asking for it made the caller name a category
 * that had nothing to do with the deletion, and the reply then said their
 * transactions had been transferred there, which was true of nothing.
 */
describe('deleting a group that is empty', () => {
  beforeEach(() => {
    vi.mocked(api.getCategoryGroups).mockReset().mockResolvedValue([
      { id: 'g1', name: 'Fixed Costs', categories: [{ id: 'c1', name: 'Rent' }] },
      { id: 'g3', name: 'Empty', categories: [] },
    ] as never);
    vi.mocked(api.getCategories).mockReset().mockResolvedValue([
      { id: 'c1', name: 'Rent', group_id: 'g1' },
    ] as never);
    vi.mocked(api.deleteCategoryGroup).mockReset().mockResolvedValue(undefined as never);
  });

  it('previews without asking where anything should go', async () => {
    const result = await deleteCategoryGroupGuarded({ group: 'Empty' });

    expect(result.deleted).toBe(false);
    const text = result.lines.join('\n');
    expect(text).toContain('The group is empty: no categories, no transactions to move.');
    expect(text).not.toContain('move to');
    expect(api.deleteCategoryGroup).not.toHaveBeenCalled();
  });

  it('deletes with no transfer_to, and says nothing moved', async () => {
    const result = await deleteCategoryGroupGuarded({
      group: 'Empty',
      confirm: true,
      confirm_name: 'Empty',
    });

    expect(result.deleted).toBe(true);
    expect(api.deleteCategoryGroup).toHaveBeenCalledWith('g3', undefined);
    const text = result.lines.join('\n');
    expect(text).toContain('Category group "Empty" deleted.');
    expect(text).toContain('It was empty, so nothing moved.');
    expect(text).not.toContain('transferred');
  });

  it('still refuses a group with categories and no transfer_to', async () => {
    await expect(deleteCategoryGroupGuarded({ group: 'Fixed Costs' })).rejects.toThrow(
      /has 1 category in it, so deleting it needs transfer_to/,
    );
    expect(api.deleteCategoryGroup).not.toHaveBeenCalled();
  });

  it('counts the categories it names in that refusal', async () => {
    vi.mocked(api.getCategories).mockResolvedValue([
      { id: 'c1', name: 'Rent', group_id: 'g1' },
      { id: 'c2', name: 'Internet', group_id: 'g1' },
    ] as never);

    await expect(deleteCategoryGroupGuarded({ group: 'Fixed Costs' })).rejects.toThrow(
      /has 2 categories in it/,
    );
  });
});
