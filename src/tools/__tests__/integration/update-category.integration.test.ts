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

  /**
   * Unhidden, and still invisible (#247).
   *
   * Measured in #238: hiding a group leaves every category in it with
   * `hidden: false`, and the app shows none of them. So a category can be
   * unhidden and stay out of the budget table, and "Hidden true -> false" on
   * its own reads as "it is back".
   */
  describe('a category inside a hidden group', () => {
    let archived = '';
    let archive = '';
    let everyday = '';
    let ordinary = '';

    beforeAll(async () => {
      await createFreshBudget(async () => {
        everyday = await api.createCategoryGroup({ name: 'Everyday' } as never);
        archive = await api.createCategoryGroup({ name: 'Archive' } as never);
        ordinary = await api.createCategory({ name: 'Groceries', group_id: everyday } as never);
        archived = await api.createCategory({ name: 'Old Thing', group_id: archive } as never);
      }, 'update-cat-hidden-group');
      await api.updateCategory(archived, { name: 'Old Thing', hidden: true } as never);
      await api.updateCategoryGroup(archive, { name: 'Archive', hidden: true } as never);
    }, 60_000);

    it('says the group is still hiding it', async () => {
      const reply = await handlerFor()({ category: archived, hidden: false });

      expect(reply.isError, reply.content[0]?.text).toBeUndefined();
      const text = reply.content[0].text;
      expect(text).toContain('Hidden true -> false');
      expect(text).toContain('Archive is hidden, so Old Thing is still not in the budget table');
      expect(text).toContain('update_category_group');
      expect(await readBack(archived)).toEqual({ name: 'Old Thing', hidden: false });
    }, 60_000);

    it('says it by name as well as by id', async () => {
      await handlerFor()({ category: archived, hidden: true });

      const reply = await handlerFor()({ category: 'Old Thing', hidden: false });

      expect(reply.isError, reply.content[0]?.text).toBeUndefined();
      expect(reply.content[0].text).toContain(
        'Archive is hidden, so Old Thing is still not in the budget table',
      );
    }, 60_000);

    it('says it even when the category was already visible', async () => {
      // Nothing changed, and the reason the category is not in the table is
      // the same one: the caller asked for it to be visible and it is not.
      const reply = await handlerFor()({ category: archived, hidden: false });

      expect(reply.isError, reply.content[0]?.text).toBeUndefined();
      const text = reply.content[0].text;
      expect(text).toContain('already had those values');
      expect(text).toContain('Archive is hidden, so Old Thing is still not in the budget table');
    }, 60_000);

    it('says nothing of the sort for a rename, which is not about coming back', async () => {
      // `hidden` is absent here, not false. The sentence is about a category
      // that was asked to come back, and a rename did not ask.
      const reply = await handlerFor()({ category: archived, name: 'Older Thing' });

      expect(reply.isError, reply.content[0]?.text).toBeUndefined();
      expect(reply.content[0].text).not.toContain('still not in the budget table');
      await handlerFor()({ category: archived, name: 'Old Thing' });
    }, 60_000);

    it('says nothing of the sort when the group is visible', async () => {
      await handlerFor()({ category: ordinary, hidden: true });

      const reply = await handlerFor()({ category: ordinary, hidden: false });

      expect(reply.isError, reply.content[0]?.text).toBeUndefined();
      expect(reply.content[0].text).not.toContain('still not in the budget table');
    }, 60_000);

    it('says nothing of the sort when it was hiding rather than unhiding', async () => {
      // Hiding a category inside a hidden group changes nothing about what
      // anyone can see, and the sentence is about coming back.
      const reply = await handlerFor()({ category: archived, hidden: true });

      expect(reply.isError, reply.content[0]?.text).toBeUndefined();
      expect(reply.content[0].text).not.toContain('still not in the budget table');
    }, 60_000);
  });

  /**
   * What the reply says (#237).
   *
   * It used to answer with the fields alone, so hiding one came back as
   * `Category updated:\n  Hidden: true` and nothing in it said which
   * category that was. By id, or with a name that matched one of several,
   * confirming the right one meant a second call to `get_categories`.
   */
  describe('the reply', () => {
    let snacks = '';

    beforeAll(async () => {
      await createFreshBudget(async () => {
        const group = await api.createCategoryGroup({ name: 'Everyday' } as never);
        snacks = await api.createCategory({ name: 'Snacks', group_id: group } as never);
      }, 'update-cat-reply');
    }, 60_000);

    it('names the category and its group when it was asked for by id', async () => {
      const reply = await handlerFor()({ category: snacks, name: 'Treats' });

      expect(reply.isError, reply.content[0]?.text).toBeUndefined();
      const text = reply.content[0].text;
      expect(text).toContain('Updated Treats in Everyday.');
      expect(text).toContain('  Name   Snacks -> Treats');
    }, 60_000);

    it('gives the old and the new value of what it hid', async () => {
      const reply = await handlerFor()({ category: snacks, hidden: true });

      expect(reply.isError, reply.content[0]?.text).toBeUndefined();
      const text = reply.content[0].text;
      expect(text).toContain('Updated Treats in Everyday.');
      expect(text).toContain('  Hidden false -> true');
      expect(text, 'the name was not touched, so it is not listed').not.toContain('Name');
    }, 60_000);

    it('says when the category already had what was asked for', async () => {
      const reply = await handlerFor()({ category: snacks, name: 'Treats', hidden: true });

      expect(reply.isError, reply.content[0]?.text).toBeUndefined();
      const text = reply.content[0].text;
      expect(text).toContain('already had those values, so nothing changed');
      expect(text).toContain('  Name   Treats (already that)');
      expect(text).toContain('  Hidden true (already that)');
    }, 60_000);

    it('quotes the name the budget stored, not the one that was sent', async () => {
      // Measured: Actual trims the name, so answering with the argument
      // would quote a name that is not in the budget.
      const reply = await handlerFor()({ category: snacks, name: '  Groceries  ' });

      expect(reply.isError, reply.content[0]?.text).toBeUndefined();
      const text = reply.content[0].text;
      expect(text).toContain('  Name   Treats -> Groceries');
      expect(text).not.toContain('  Groceries  ');
      expect(await readBack(snacks)).toEqual({ name: 'Groceries', hidden: true });
    }, 60_000);

    it('lists both fields when both changed', async () => {
      const reply = await handlerFor()({ category: snacks, name: 'Snacks', hidden: false });

      expect(reply.isError, reply.content[0]?.text).toBeUndefined();
      const text = reply.content[0].text;
      expect(text).toContain('Updated Snacks in Everyday.');
      expect(text).toContain('  Name   Groceries -> Snacks');
      expect(text).toContain('  Hidden true -> false');
    }, 60_000);
  });
});
