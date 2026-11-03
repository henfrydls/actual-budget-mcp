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
import { registerAllResources } from '../../../resources.js';

const skip = process.env.SKIP_ACTUAL_INTEGRATION === '1';

type Tool = (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }>;

function categoriesTool(): Tool {
  let handler: Tool | undefined;
  registerGetCategories({
    tool: (...a: unknown[]) => {
      handler = a.at(-1) as Tool;
    },
  } as never);
  return handler as Tool;
}

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

/**
 * A group with nothing in it is still a group (#283).
 *
 * Seen in the live test: a group created a moment ago with
 * `create_category_group` was not in the reply at all, so there was no way
 * to read its id back, and the only tool that lists groups had just hidden
 * the one thing that was asked for.
 *
 * Empty means no categories at all. A group whose categories are all hidden
 * is not empty: it has categories, and the closing line is what says so.
 * Both halves are built here from the real engine, because both are about
 * what the engine stores rather than what a mock was told to return.
 */
describe.skipIf(skip)('a category group with no categories', () => {
  let brandNew = '';
  let archived = '';
  let putAway = '';

  beforeAll(async () => {
    await initTestEngine();
    await createFreshBudget(async () => {
      // One with categories, so the reply has something ordinary in it.
      const everyday = await api.createCategoryGroup({ name: 'Everyday' } as never);
      await api.createCategory({ name: 'Groceries', group_id: everyday } as never);

      // The case from the issue: created and nothing put in it yet.
      brandNew = await api.createCategoryGroup({ name: 'Brand New' } as never);

      // Empty and hidden, which is two marks on one line.
      putAway = await api.createCategoryGroup({ name: 'Put Away' } as never);
      await api.updateCategoryGroup(putAway, { name: 'Put Away', hidden: true } as never);

      // Not empty: it has one category, and that category is hidden.
      archived = await api.createCategoryGroup({ name: 'Archived' } as never);
      const old = await api.createCategory({ name: 'Old Thing', group_id: archived } as never);
      await api.updateCategory(old, { name: 'Old Thing', hidden: true } as never);
    }, 'empty-groups');
  }, 60_000);

  afterAll(async () => {
    await shutdownTestEngine();
  });

  async function listing(args: Record<string, unknown> = {}): Promise<string> {
    return (await categoriesTool()(args)).content[0].text;
  }

  it('lists a group with nothing in it, with its id and a mark', async () => {
    const text = await listing();

    expect(text).toContain(`Brand New (${brandNew})  [empty]`);
  });

  it('marks one that is empty and hidden as both', async () => {
    const text = await listing();

    expect(text).toContain(`Put Away (${putAway})  [hidden]  [empty]`);
  });

  it('does not call a group empty when its categories are hidden', async () => {
    const text = await listing();
    const line = text.split('\n').find((l) => l.startsWith('Archived'));

    // It stays out of the listing as it did before, and the closing line is
    // what says its category is there. Calling it empty would be untrue.
    expect(line).toBeUndefined();
    expect(text).toContain('Not listed: 1 hidden category');
  });

  it('shows that group, and not the mark, when hidden ones are asked for', async () => {
    const text = await listing({ include_hidden: true });

    expect(text).toContain(`Archived (${archived})`);
    expect(text).not.toContain(`Archived (${archived})  [empty]`);
    expect(text).toContain('Old Thing');
  });

  it('says the same thing through the resource', async () => {
    // Two ways of asking the same question, which is what #248 is about.
    const text = (await categoriesResource()()).contents[0].text;

    expect(text).toContain(`Brand New (${brandNew})  [empty]`);
    expect(text).toContain(`Put Away (${putAway})  [empty]`);
    expect(text).not.toContain('Archived');
    expect(text).toContain('Not listed: 1 hidden category');
  });
});
