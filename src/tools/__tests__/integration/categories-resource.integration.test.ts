import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

vi.mock('@actual-app/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@actual-app/api')>();
  return { ...actual, sync: vi.fn().mockResolvedValue(undefined) };
});
vi.mock('../../../connection.js', () => ({
  ensureConnection: vi.fn().mockResolvedValue(undefined),
}));

import { initTestEngine, shutdownTestEngine, createFreshBudget, api } from './actual-engine.js';
import { registerAllResources } from '../../../resources.js';
import { registerGetCategories } from '../../read/get-categories.js';

const skip = process.env.SKIP_ACTUAL_INTEGRATION === '1';

/** The `actual://categories` resource's own handler. */
function categoriesResource(): () => Promise<{ contents: Array<{ text: string }> }> {
  let handler: (() => Promise<{ contents: Array<{ text: string }> }>) | undefined;
  registerAllResources({
    // `tool` as well as `resource`: the wrappers around registration bind
    // both, and a stub with one of them throws on its way in.
    tool: () => {},
    resource: (name: string, ...args: unknown[]) => {
      if (name === 'categories') handler = args[args.length - 1] as never;
    },
  } as never);
  if (!handler) throw new Error('the categories resource did not register');
  return handler;
}

function categoriesTool(): (args: Record<string, unknown>) => Promise<{
  content: Array<{ text: string }>;
}> {
  let handler: ((args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }>) | undefined;
  registerGetCategories({
    tool: (...a: unknown[]) => {
      handler = a.at(-1) as never;
    },
  } as never);
  return handler as never;
}

/**
 * The resource and the tool answer the same question (#248).
 *
 * `get_categories` learned to leave out hidden categories and the ones whose
 * group is hidden, and to say how many it left out (#238). The resource kept
 * its own rule, so it listed categories the app does not show and the tool
 * had just said it was leaving out. Two ways of asking, two answers.
 */
describe.skipIf(skip)('the categories resource', () => {
  let visible = '';
  let hiddenOne = '';
  let inArchive = '';

  beforeAll(async () => {
    await initTestEngine();
    await createFreshBudget(async () => {
      const everyday = await api.createCategoryGroup({ name: 'Everyday' } as never);
      const archive = await api.createCategoryGroup({ name: 'Archive' } as never);
      visible = await api.createCategory({ name: 'Groceries', group_id: everyday } as never);
      hiddenOne = await api.createCategory({ name: 'Snacks', group_id: everyday } as never);
      inArchive = await api.createCategory({ name: 'Old Thing', group_id: archive } as never);
      await api.updateCategory(hiddenOne, { name: 'Snacks', hidden: true } as never);
      await api.updateCategoryGroup(archive, { name: 'Archive', hidden: true } as never);
    }, 'categories-resource');
  }, 120_000);

  afterAll(async () => {
    await shutdownTestEngine();
  });

  it('leaves out what the tool leaves out', async () => {
    const text = (await categoriesResource()()).contents[0].text;

    expect(text).toContain(`Groceries (${visible})`);
    expect(text).not.toContain(`Snacks (${hiddenOne})`);
    expect(text).not.toContain(`Old Thing (${inArchive})`);
    expect(text).not.toContain('Archive');
  }, 60_000);

  it('names every category the tool names, and no others', async () => {
    // The point of the issue: the two listings describe one budget.
    const ids = (text: string) => [...text.matchAll(/\(([0-9a-f-]{36})\)/g)].map((m) => m[1]).sort();
    const fromResource = ids((await categoriesResource()()).contents[0].text);
    const fromTool = ids((await categoriesTool()({})).content[0].text);

    expect(fromResource).toEqual(fromTool);
  }, 60_000);

  it('says what it is not showing, and where to ask for it', async () => {
    const text = (await categoriesResource()()).contents[0].text;

    expect(text).toContain('Not listed: 1 hidden category, and 1 category in a hidden group.');
    expect(text).toContain('Ask get_categories with include_hidden: true to see them.');
  }, 60_000);

  it('says nothing about it when there is nothing hidden', async () => {
    await createFreshBudget(async () => {
      const group = await api.createCategoryGroup({ name: 'Everyday' } as never);
      await api.createCategory({ name: 'Groceries', group_id: group } as never);
    }, 'categories-resource-plain');

    const text = (await categoriesResource()()).contents[0].text;

    expect(text).toContain('Groceries');
    expect(text).not.toContain('Not listed');
  }, 60_000);
});
