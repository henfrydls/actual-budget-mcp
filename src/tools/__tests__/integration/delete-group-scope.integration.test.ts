import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

vi.mock('@actual-app/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@actual-app/api')>();
  return { ...actual, sync: vi.fn().mockResolvedValue(undefined) };
});
vi.mock('../../../connection.js', () => ({
  ensureConnection: vi.fn().mockResolvedValue(undefined),
}));

import { initTestEngine, shutdownTestEngine, createFreshBudget, api } from './actual-engine.js';
import { deleteCategoryGroupGuarded } from '../../write/delete-category-group.js';

const skip = process.env.SKIP_ACTUAL_INTEGRATION === '1';

/**
 * Which categories count as being in the group (#266).
 *
 * `transfer_to` is required when the group has categories, because their
 * transactions have to go somewhere. What decides that is one filter, and if
 * it ever stopped counting the hidden ones or the income ones, a group that
 * is not empty would be deleted as though it were: no transfer asked for, a
 * reply saying nothing moved, and transactions left with no category.
 *
 * The unit tests above can be made to pass with a filter that lies, because
 * they hand it the list. These ask the engine.
 */
describe.skipIf(skip)('what counts as a category in the group', () => {
  let hiddenOnly = '';
  let incomeOnly = '';
  let spending = '';

  beforeAll(async () => {
    await initTestEngine();
    await createFreshBudget(async () => {
      spending = await api.createCategoryGroup({ name: 'Everyday' } as never);
      await api.createCategory({ name: 'Groceries', group_id: spending } as never);

      hiddenOnly = await api.createCategoryGroup({ name: 'Archive' } as never);
      const archived = await api.createCategory({
        name: 'Old Thing',
        group_id: hiddenOnly,
      } as never);
      await api.updateCategory(archived, { name: 'Old Thing', hidden: true } as never);

      incomeOnly = await api.createCategoryGroup({ name: 'Earnings' } as never);
      await api.createCategory({
        name: 'Bonus',
        group_id: incomeOnly,
        is_income: true,
      } as never);
    }, 'delete-group-scope');
  }, 120_000);

  afterAll(async () => {
    await shutdownTestEngine();
  });

  it('counts a hidden category, so the group is not empty', async () => {
    await expect(deleteCategoryGroupGuarded({ group: 'Archive' })).rejects.toThrow(
      /has 1 category in it, so deleting it needs transfer_to/,
    );
  }, 60_000);

  it('counts an income category, so that group is not empty either', async () => {
    await expect(deleteCategoryGroupGuarded({ group: 'Earnings' })).rejects.toThrow(
      /has 1 category in it, so deleting it needs transfer_to/,
    );
  }, 60_000);

  it('previews the hidden one by name, so the scope is visible before agreeing', async () => {
    const result = await deleteCategoryGroupGuarded({
      group: 'Archive',
      transfer_to: 'Groceries',
    });

    expect(result.deleted).toBe(false);
    const text = result.lines.join('\n');
    expect(text).toContain('Categories destroyed: 1');
    expect(text).toContain('Old Thing');
    expect(text).not.toContain('The group is empty');
  }, 60_000);

  it('refuses a transfer_to that is not a category, even for an empty group', async () => {
    const empty = await api.createCategoryGroup({ name: 'Nothing Here' } as never);
    expect(empty).toBeTruthy();

    await expect(
      deleteCategoryGroupGuarded({ group: 'Nothing Here', transfer_to: 'No Such Category' }),
    ).rejects.toThrow(/No category found matching/);
  }, 60_000);

  it('still deletes a genuinely empty group with no transfer_to', async () => {
    const before = (await api.getCategoryGroups()).length;

    const result = await deleteCategoryGroupGuarded({
      group: 'Nothing Here',
      confirm: true,
      confirm_name: 'Nothing Here',
    });

    expect(result.deleted).toBe(true);
    expect(result.lines.join('\n')).toContain('It was empty, so nothing moved.');
    expect((await api.getCategoryGroups()).length).toBe(before - 1);
  }, 60_000);
});
