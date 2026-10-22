import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@actual-app/api', () => ({
  default: {},
  getCategoryGroups: vi.fn(),
  updateCategoryGroup: vi.fn(),
  sync: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../connection.js', () => ({
  ensureConnection: vi.fn().mockResolvedValue(undefined),
}));

import * as api from '@actual-app/api';
import { registerUpdateCategoryGroup } from '../write/update-category-group.js';

type Handler = (args: Record<string, unknown>) => Promise<{
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}>;

function handlerFor(): Handler {
  let handler: Handler | undefined;
  registerUpdateCategoryGroup({
    tool: (...a: unknown[]) => {
      handler = a.at(-1) as Handler;
    },
  } as never);
  return handler as Handler;
}

/**
 * The group whose name cannot be read (#260).
 *
 * Actual needs a name on every group update, so one that carries only
 * `hidden` sends the name the group already has. If that name is not there,
 * writing without it throws inside the engine with a message about
 * `toUpperCase`, which says nothing about what happened. Against the real
 * engine this cannot be reached, because the group was just resolved by
 * name or id, so it is pinned here.
 */
describe('update_category_group when the group has no readable name', () => {
  beforeEach(() => {
    vi.mocked(api.updateCategoryGroup).mockReset().mockResolvedValue(undefined as never);
  });

  it('says so, and writes nothing', async () => {
    // The resolver sees a group with a name; the read after it does not.
    let reads = 0;
    vi.mocked(api.getCategoryGroups).mockImplementation(async () => {
      reads += 1;
      return (reads === 1 ? [{ id: 'g1', name: 'Everyday' }] : [{ id: 'g1' }]) as never;
    });

    const result = await handlerFor()({ group: 'g1', hidden: true });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Could not read the current name');
    expect(result.content[0].text).toContain('Nothing was changed');
    expect(api.updateCategoryGroup).not.toHaveBeenCalled();
  });

  it('sends the name it read, with the flag', async () => {
    vi.mocked(api.getCategoryGroups).mockResolvedValue([
      { id: 'g1', name: 'Everyday' },
    ] as never);

    const result = await handlerFor()({ group: 'g1', hidden: true });

    expect(result.isError).toBeFalsy();
    expect(api.updateCategoryGroup).toHaveBeenCalledWith('g1', {
      name: 'Everyday',
      hidden: true,
    });
  });
});
