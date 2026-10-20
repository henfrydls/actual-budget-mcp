import { describe, it, expect, vi, beforeEach } from 'vitest';

const getCategories = vi.fn();
vi.mock('@actual-app/api', () => ({
  default: {},
  getCategories: (...a: unknown[]) => getCategories(...a),
  utils: {},
}));
vi.mock('../../connection.js', () => ({ ensureConnection: vi.fn().mockResolvedValue(undefined) }));

import { resolveCategoryId } from '../resolvers.js';

/**
 * A hidden category, and who is allowed to find it by name (#218).
 *
 * It is left out of the match everywhere else on purpose: hidden means
 * nobody wants it offered, and a transaction should not land in one by a
 * name that also fits something visible. `update_category` is the exception,
 * because unhiding one is its job.
 */
const budget = [
  { id: 'c-1', name: 'Groceries', group_id: 'g-1', hidden: true },
  { id: 'c-2', name: 'Rent', group_id: 'g-1', hidden: false },
];

describe('resolving a category that is hidden', () => {
  beforeEach(() => {
    getCategories.mockReset().mockResolvedValue(budget);
  });

  it('is not found by name by default', async () => {
    await expect(resolveCategoryId('Groceries')).rejects.toThrow(/No category found/);
  });

  it('is found by name when the caller asks for hidden ones', async () => {
    await expect(resolveCategoryId('Groceries', { includeHidden: true })).resolves.toBe('c-1');
  });

  it('is always found by id, hidden or not', async () => {
    await expect(resolveCategoryId('c-1')).resolves.toBe('c-1');
  });

  it('says a hidden one matches, instead of listing what is visible and stopping', async () => {
    // The old message said `No category found matching "Groceries". Available:
    // Rent`, with the category sitting right there.
    const said = await resolveCategoryId('Groceries').catch((e: Error) => e.message);

    expect(said).toContain('A hidden category is named "Groceries"');
    expect(said).toContain('update_category');
  });

  it('leaves the visible ones working as they did', async () => {
    await expect(resolveCategoryId('Rent')).resolves.toBe('c-2');
  });
});
