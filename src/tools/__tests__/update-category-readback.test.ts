import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@actual-app/api', () => ({
  default: {},
  getCategories: vi.fn(),
  getCategoryGroups: vi.fn(),
  updateCategory: vi.fn(),
  sync: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../connection.js', () => ({
  ensureConnection: vi.fn().mockResolvedValue(undefined),
}));

import * as api from '@actual-app/api';
import { registerUpdateCategory } from '../write/update-category.js';

type Handler = (args: Record<string, unknown>) => Promise<{
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}>;

function handlerFor(): Handler {
  let handler: Handler | undefined;
  registerUpdateCategory({
    tool: (...a: unknown[]) => {
      handler = a.at(-1) as Handler;
    },
  } as never);
  return handler as Handler;
}

/**
 * The branch that says a write did not land (#237).
 *
 * Against the real engine it cannot be reached: `updateCategory` writes what
 * it is given. It exists because that handler reports nothing either way, so
 * the alternative is reporting a change this server never confirmed, and a
 * branch with no test is a branch that is wrong the day it runs. The engine
 * is stubbed here to answer as though the write had been dropped.
 */
describe('update_category when the budget disagrees with the write', () => {
  beforeEach(() => {
    vi.mocked(api.getCategories).mockReset().mockResolvedValue([
      { id: 'c1', name: 'Groceries', group_id: 'g1', hidden: false },
    ] as never);
    vi.mocked(api.getCategoryGroups).mockReset().mockResolvedValue([
      { id: 'g1', name: 'Everyday', categories: [] },
    ] as never);
    vi.mocked(api.updateCategory).mockReset().mockResolvedValue(undefined as never);
  });

  it('reports the category as it is, and as an error, when the name did not take', async () => {
    const result = await handlerFor()({ category: 'c1', name: 'Food' });

    expect(result.isError).toBe(true);
    const text = result.content[0].text;
    expect(text).toContain('Actual accepted the change to Groceries in Everyday');
    expect(text).toContain('Name   Groceries');
    expect(text).toContain('Check this category in Actual');
  });

  it('does the same when the hidden flag did not take', async () => {
    const result = await handlerFor()({ category: 'c1', hidden: true });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Hidden false');
  });

  it('says so when the category is gone after the update', async () => {
    // The read after the write is the one that comes back empty; the reads
    // before it are how the category was found in the first place.
    const rows = [{ id: 'c1', name: 'Groceries', group_id: 'g1', hidden: false }];
    let writes = 0;
    vi.mocked(api.updateCategory).mockImplementation(async () => {
      writes += 1;
    });
    vi.mocked(api.getCategories).mockImplementation(
      async () => (writes === 0 ? rows : []) as never,
    );

    const result = await handlerFor()({ category: 'c1', name: 'Food' });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('no longer in the budget');
  });

  it('reads a row with no hidden field as not hidden', async () => {
    // `getCategories` is published as `{ id, name }`, so a row without the
    // flag is inside what the type promises. Asking to unhide one then has
    // to come back as "already that" rather than as a change from nothing.
    vi.mocked(api.getCategories).mockResolvedValue([
      { id: 'c1', name: 'Groceries', group_id: 'g1' },
    ] as never);

    const result = await handlerFor()({ category: 'c1', hidden: false });

    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain('Hidden false (already that)');
    expect(result.content[0].text).toContain('already had those values');
  });

  it('names the category alone when its group cannot be read', async () => {
    vi.mocked(api.getCategoryGroups).mockResolvedValue([] as never);

    const result = await handlerFor()({ category: 'c1', name: 'Groceries' });

    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain('Groceries already had those values');
    expect(result.content[0].text).not.toContain(' in ');
  });
});
