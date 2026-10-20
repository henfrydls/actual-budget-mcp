import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

vi.mock('@actual-app/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@actual-app/api')>();
  return { ...actual, sync: vi.fn().mockResolvedValue(undefined) };
});

vi.mock('../../../connection.js', () => ({
  ensureConnection: vi.fn().mockResolvedValue(undefined),
}));

import { initTestEngine, shutdownTestEngine, createFreshBudget, api } from './actual-engine.js';
import { registerUpdateCategory } from '../../write/update-category.js';

const skip = process.env.SKIP_ACTUAL_INTEGRATION === '1';

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

/** The category as the budget holds it, read back rather than assumed. */
async function readBack(id: string) {
  const found = (await api.getCategories()).find((c) => c.id === id);
  return { name: found?.name, hidden: (found as { hidden?: boolean } | undefined)?.hidden };
}

/**
 * Hiding a category without renaming it (#218).
 *
 * Actual trims the name without checking there is one, so an update carrying
 * only `hidden` throws on `name.trim()` before anything is written:
 * actualbudget/actual#8857, and the fix upstream has not landed. Measured
 * against the engine this suite runs, and still there in the 26.11 nightly.
 */
describe.skipIf(skip)('update_category against the real engine', () => {
  let groceries = '';

  beforeAll(async () => {
    await initTestEngine();
    await createFreshBudget(async () => {
      const group = await api.createCategoryGroup({ name: 'Everyday' } as never);
      groceries = await api.createCategory({ name: 'Groceries', group_id: group } as never);
    });
  }, 120_000);

  afterAll(async () => {
    await shutdownTestEngine();
  });

  it('hides a category and leaves its name alone', async () => {
    const reply = await handlerFor()({ category: groceries, hidden: true });

    expect(reply.isError, reply.content[0]?.text).toBeUndefined();
    expect(await readBack(groceries)).toEqual({ name: 'Groceries', hidden: true });
  }, 60_000);

  it('unhides it again', async () => {
    const reply = await handlerFor()({ category: groceries, hidden: false });

    expect(reply.isError, reply.content[0]?.text).toBeUndefined();
    expect(await readBack(groceries)).toEqual({ name: 'Groceries', hidden: false });
  }, 60_000);

  it('hides by name as well as by id, without renaming it to the name', async () => {
    const reply = await handlerFor()({ category: 'Groceries', hidden: true });

    expect(reply.isError, reply.content[0]?.text).toBeUndefined();
    expect(await readBack(groceries)).toEqual({ name: 'Groceries', hidden: true });
    await handlerFor()({ category: groceries, hidden: false });
  }, 60_000);

  it('unhides by name, which is the half that could not work', async () => {
    // Measured while fixing this: a hidden category is left out of the name
    // match, so hiding one by name meant it could only be brought back by
    // id, and the error listed the visible ones as if it were not there.
    await handlerFor()({ category: 'Groceries', hidden: true });

    const reply = await handlerFor()({ category: 'Groceries', hidden: false });

    expect(reply.isError, reply.content[0]?.text).toBeUndefined();
    expect(await readBack(groceries)).toEqual({ name: 'Groceries', hidden: false });
  }, 60_000);

  it('still renames when a name is given', async () => {
    const reply = await handlerFor()({ category: groceries, name: 'Food' });

    expect(reply.isError, reply.content[0]?.text).toBeUndefined();
    expect(await readBack(groceries)).toEqual({ name: 'Food', hidden: false });
    await handlerFor()({ category: groceries, name: 'Groceries' });
  }, 60_000);

  it('renames and hides in one call', async () => {
    const reply = await handlerFor()({ category: groceries, name: 'Market', hidden: true });

    expect(reply.isError, reply.content[0]?.text).toBeUndefined();
    expect(await readBack(groceries)).toEqual({ name: 'Market', hidden: true });
  }, 60_000);

  /**
   * One name in two groups, which Actual allows (#218, round two).
   *
   * Letting this tool see the hidden ones turned an ordinary rename into
   * `Ambiguous category name "Groceries". Matches: Groceries, Groceries`, a
   * message with nothing to act on, for something that worked before.
   */
  describe('when the same name is in two groups', () => {
    let visible = '';
    let archived = '';

    beforeAll(async () => {
      const archive = await api.createCategoryGroup({ name: 'Archive' } as never);
      archived = await api.createCategory({ name: 'Twin', group_id: archive } as never);
      await handlerFor()({ category: archived, hidden: true });
      const everyday = (await api.getCategoryGroups()).find((g) => g.name === 'Everyday')!;
      visible = await api.createCategory({ name: 'Twin', group_id: everyday.id } as never);
    }, 120_000);

    it('renames the one that is in the way', async () => {
      const reply = await handlerFor()({ category: 'Twin', name: 'Twin renamed' });

      expect(reply.isError, reply.content[0]?.text).toBeUndefined();
      expect(await readBack(visible)).toEqual({ name: 'Twin renamed', hidden: false });
      expect(await readBack(archived)).toEqual({ name: 'Twin', hidden: true });
      await handlerFor()({ category: visible, name: 'Twin' });
    }, 60_000);

    it('hides the one that is in the way', async () => {
      const reply = await handlerFor()({ category: 'Twin', hidden: true });

      expect(reply.isError, reply.content[0]?.text).toBeUndefined();
      expect(await readBack(visible)).toEqual({ name: 'Twin', hidden: true });
      await handlerFor()({ category: visible, hidden: false });
    }, 60_000);

    it('unhides the hidden one', async () => {
      const reply = await handlerFor()({ category: 'Twin', hidden: false });

      expect(reply.isError, reply.content[0]?.text).toBeUndefined();
      expect(await readBack(archived)).toEqual({ name: 'Twin', hidden: false });
      await handlerFor()({ category: archived, hidden: true });
    }, 60_000);

    it('refuses, with something to act on, when both are the same kind', async () => {
      // Two visible ones named alike: nothing in the request says which.
      await handlerFor()({ category: archived, hidden: false });

      const reply = await handlerFor()({ category: 'Twin', name: 'Either' });

      expect(reply.isError).toBe(true);
      expect(reply.content[0].text).toContain('Ambiguous');
      expect(reply.content[0].text).toContain('in Everyday');
      expect(reply.content[0].text).toContain('in Archive');
      expect(reply.content[0].text).toContain('Pass the id');
      await handlerFor()({ category: archived, hidden: true });
    }, 60_000);
  });
});
