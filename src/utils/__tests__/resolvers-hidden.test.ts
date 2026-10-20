import { describe, it, expect, vi, beforeEach } from 'vitest';

const getCategories = vi.fn();
const getCategoryGroups = vi.fn();
vi.mock('@actual-app/api', () => ({
  default: {},
  getCategories: (...a: unknown[]) => getCategories(...a),
  getCategoryGroups: (...a: unknown[]) => getCategoryGroups(...a),
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
    getCategoryGroups.mockReset().mockResolvedValue([
      { id: 'g-1', name: 'Everyday' },
      { id: 'g-2', name: 'Archive' },
    ]);
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

/**
 * One name in two groups, which Actual allows (#218, round two).
 *
 * Letting `update_category` see the hidden ones turned an ordinary rename
 * into `Ambiguous category name "Groceries". Matches: Groceries, Groceries`,
 * a message with nothing to act on, for something that worked before.
 */
describe('two categories with one name', () => {
  const twins = [
    { id: 'c-visible', name: 'Groceries', group_id: 'g-1', hidden: false },
    { id: 'c-hidden', name: 'Groceries', group_id: 'g-2', hidden: true },
  ];

  beforeEach(() => {
    getCategories.mockReset().mockResolvedValue(twins);
    getCategoryGroups.mockReset().mockResolvedValue([
      { id: 'g-1', name: 'Everyday' },
      { id: 'g-2', name: 'Archive' },
    ]);
  });

  it('takes the visible one when the caller wants the one in the way', async () => {
    // Hiding it, or renaming it: the one being talked about is the one that
    // shows up in the budget.
    await expect(
      resolveCategoryId('Groceries', { includeHidden: true, prefer: 'visible' }),
    ).resolves.toBe('c-visible');
  });

  it('takes the hidden one when the caller is unhiding', async () => {
    await expect(
      resolveCategoryId('Groceries', { includeHidden: true, prefer: 'hidden' }),
    ).resolves.toBe('c-hidden');
  });

  it('still refuses when both are of the kind that was asked for', async () => {
    getCategories.mockResolvedValue([
      { id: 'c-1', name: 'Groceries', group_id: 'g-1', hidden: false },
      { id: 'c-2', name: 'Groceries', group_id: 'g-2', hidden: false },
    ]);

    const said = await resolveCategoryId('Groceries', {
      includeHidden: true,
      prefer: 'visible',
    }).catch((e: Error) => e.message);

    expect(said).toContain('Ambiguous');
  });

  it('says what tells them apart, which the names cannot', async () => {
    getCategories.mockResolvedValue([
      { id: 'c-1', name: 'Groceries', group_id: 'g-1', hidden: false },
      { id: 'c-2', name: 'Groceries', group_id: 'g-2', hidden: false },
    ]);

    const said = await resolveCategoryId('Groceries', { includeHidden: true }).catch(
      (e: Error) => e.message,
    );

    expect(said).toContain('Groceries in Everyday (c-1)');
    expect(said).toContain('Groceries in Archive (c-2)');
    expect(said).toContain('Pass the id');
  });

  it('marks the hidden one in that message', async () => {
    const said = await resolveCategoryId('Groceries', { includeHidden: true }).catch(
      (e: Error) => e.message,
    );

    expect(said).toContain('Groceries in Archive, hidden (c-hidden)');
  });

  it('says it without the groups when they cannot be read', async () => {
    getCategoryGroups.mockRejectedValue(new Error('no'));

    const said = await resolveCategoryId('Groceries', { includeHidden: true }).catch(
      (e: Error) => e.message,
    );

    expect(said).toContain('Groceries (c-visible)');
    expect(said).toContain('Groceries, hidden (c-hidden)');
  });

  it('leaves a single match alone, whatever is preferred', async () => {
    getCategories.mockResolvedValue([
      { id: 'c-only', name: 'Rent', group_id: 'g-1', hidden: true },
    ]);

    await expect(
      resolveCategoryId('Rent', { includeHidden: true, prefer: 'visible' }),
    ).resolves.toBe('c-only');
  });
});
