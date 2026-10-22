import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

vi.mock('@actual-app/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@actual-app/api')>();
  return { ...actual, sync: vi.fn().mockResolvedValue(undefined) };
});
vi.mock('../../../connection.js', () => ({
  ensureConnection: vi.fn().mockResolvedValue(undefined),
}));

import { initTestEngine, shutdownTestEngine, createFreshBudget, api } from './actual-engine.js';
import { registerGetCategories } from '../../read/get-categories.js';

const skip = process.env.SKIP_ACTUAL_INTEGRATION === '1';

type Handler = (args: Record<string, unknown>) => Promise<{
  content: Array<{ type: string; text: string }>;
}>;

function handlerFor(): Handler {
  let handler: Handler | undefined;
  registerGetCategories({
    tool: (...a: unknown[]) => {
      handler = a.at(-1) as Handler;
    },
  } as never);
  return handler as Handler;
}

/**
 * What the list does not show, and what it says about that (#238).
 *
 * Seen in the live test of 0.10.9: a hidden category was in
 * `get_budget_month` and not here, so finding it in order to unhide it meant
 * knowing it was there.
 *
 * The hidden group is the half that was measured while fixing this: hiding a
 * group leaves every category in it with `hidden: false`, so they were listed
 * as ordinary categories while the app showed none of them.
 */
describe.skipIf(skip)('get_categories and the categories it leaves out', () => {
  let everyday = '';
  let archive = '';
  let groceries = '';
  let snacks = '';
  let rent = '';
  let bonus = '';
  let old = '';

  beforeAll(async () => {
    await initTestEngine();
    await createFreshBudget(async () => {
      everyday = await api.createCategoryGroup({ name: 'Everyday' } as never);
      archive = await api.createCategoryGroup({ name: 'Archive' } as never);
      groceries = await api.createCategory({ name: 'Groceries', group_id: everyday } as never);
      snacks = await api.createCategory({ name: 'Snacks', group_id: everyday } as never);
      rent = await api.createCategory({ name: 'Rent', group_id: archive } as never);
      old = await api.createCategory({ name: 'Old', group_id: archive } as never);
      const income = (await api.getCategoryGroups()).find((g) => g.is_income);
      bonus = await api.createCategory({
        name: 'Bonus',
        group_id: income?.id,
        is_income: true,
      } as never);
    }, 'get-cats-hidden');
    // A hidden category, and a hidden group whose category is not hidden.
    await api.updateCategory(snacks, { name: 'Snacks', hidden: true } as never);
    await api.updateCategory(bonus, { name: 'Bonus', hidden: true } as never);
    // Hidden and in a hidden group: one category, counted once.
    await api.updateCategory(old, { name: 'Old', hidden: true } as never);
    await api.updateCategoryGroup(archive, { name: 'Archive', hidden: true } as never);
  }, 120_000);

  afterAll(async () => {
    await shutdownTestEngine();
  });

  it('leaves them out and says how many, apart', async () => {
    const text = (await handlerFor()({})).content[0].text;

    expect(text).toContain(`Groceries (${groceries})`);
    expect(text).not.toContain(`Snacks (${snacks})`);
    expect(text).not.toContain(`Rent (${rent})`);
    expect(text).not.toContain(`Bonus (${bonus})`);
    expect(text).not.toContain(`Old (${old})`);
    // Three of their own, one through its group, and what to pass to see
    // them. "Old" is both, and is counted once.
    expect(text).toContain(
      'Not listed: 3 hidden categories, and 1 category in a hidden group. ' +
        'Pass include_hidden: true to see them.',
    );
  }, 60_000);

  it('does not name a group that has nothing left to show', async () => {
    const text = (await handlerFor()({})).content[0].text;

    expect(text).not.toContain('Archive');
  }, 60_000);

  it('lists them when asked, each marked for what it is', async () => {
    const text = (await handlerFor()({ include_hidden: true })).content[0].text;

    expect(text).toContain(`  Snacks (${snacks})  [hidden]`);
    expect(text).toContain(`  Rent (${rent})  [in a hidden group]`);
    expect(text).toContain(`  Bonus (${bonus})  [hidden]`);
    expect(text).toContain(`Archive (${archive})  [hidden]`);
    // The ordinary ones are unmarked, which is what makes a mark mean
    // something.
    expect(text).toContain(`  Groceries (${groceries})\n`);
    expect(text).not.toContain('Not listed:');
  }, 60_000);

  it('says nothing about hidden ones when there are none', async () => {
    await createFreshBudget(async () => {
      const group = await api.createCategoryGroup({ name: 'Everyday' } as never);
      await api.createCategory({ name: 'Groceries', group_id: group } as never);
    }, 'get-cats-plain');

    const text = (await handlerFor()({})).content[0].text;

    expect(text).toContain('Groceries');
    expect(text).not.toContain('Not listed');
    expect(text).not.toContain('include_hidden');
  }, 60_000);

  it('counts one of each in the singular', async () => {
    let only = '';
    await createFreshBudget(async () => {
      const group = await api.createCategoryGroup({ name: 'Everyday' } as never);
      const gone = await api.createCategoryGroup({ name: 'Archive' } as never);
      only = await api.createCategory({ name: 'Snacks', group_id: group } as never);
      await api.createCategory({ name: 'Rent', group_id: gone } as never);
      await api.createCategory({ name: 'Groceries', group_id: group } as never);
      await api.updateCategoryGroup(gone, { name: 'Archive', hidden: true } as never);
    }, 'get-cats-singular');
    await api.updateCategory(only, { name: 'Snacks', hidden: true } as never);

    const text = (await handlerFor()({})).content[0].text;

    expect(text).toContain(
      'Not listed: 1 hidden category, and 1 category in a hidden group. ' +
        'Pass include_hidden: true to see them.',
    );
  }, 60_000);
});
