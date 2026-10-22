import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

vi.mock('@actual-app/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@actual-app/api')>();
  return { ...actual, sync: vi.fn().mockResolvedValue(undefined) };
});
vi.mock('../../../connection.js', () => ({
  ensureConnection: vi.fn().mockResolvedValue(undefined),
}));

import { initTestEngine, shutdownTestEngine, createFreshBudget, api } from './actual-engine.js';
import { registerUpdateCategoryGroup } from '../../write/update-category-group.js';

const skip = process.env.SKIP_ACTUAL_INTEGRATION === '1';

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
 * Hiding a group without renaming it (#260).
 *
 * `db.updateCategoryGroup` looks for another group with the same name before
 * writing anything, `group.name.toUpperCase()`, without checking there is a
 * name. An update carrying only `hidden` threw
 * `Cannot read properties of undefined (reading 'toUpperCase')` and wrote
 * nothing: the same shape as actualbudget/actual#8857, which
 * `update_category` already works around by sending the name the category
 * already has.
 *
 * It matters more than it looks: #247 tells the reader to use this tool to
 * bring back a category whose group is hiding it.
 */
describe.skipIf(skip)('update_category_group without a new name', () => {
  let everyday = '';

  beforeAll(async () => {
    await initTestEngine();
    await createFreshBudget(async () => {
      everyday = await api.createCategoryGroup({ name: 'Everyday' } as never);
    }, 'group-hidden');
  }, 120_000);

  afterAll(async () => {
    await shutdownTestEngine();
  });

  const groupNow = async () =>
    (await api.getCategoryGroups()).find((g) => g.id === everyday) as
      | { name: string; hidden?: boolean }
      | undefined;

  it('hides it by id, and leaves the name alone', async () => {
    const reply = await handlerFor()({ group: everyday, hidden: true });

    expect(reply.isError, reply.content[0]?.text).toBeFalsy();
    expect(await groupNow()).toMatchObject({ name: 'Everyday', hidden: true });
  }, 60_000);

  it('unhides it again, which is what #247 sends people here for', async () => {
    const reply = await handlerFor()({ group: everyday, hidden: false });

    expect(reply.isError, reply.content[0]?.text).toBeFalsy();
    expect(await groupNow()).toMatchObject({ name: 'Everyday', hidden: false });
  }, 60_000);

  it('hides it by name as well, without renaming it to the name', async () => {
    const reply = await handlerFor()({ group: 'Everyday', hidden: true });

    expect(reply.isError, reply.content[0]?.text).toBeFalsy();
    expect(await groupNow()).toMatchObject({ name: 'Everyday', hidden: true });
    await handlerFor()({ group: everyday, hidden: false });
  }, 60_000);

  it('still renames when a name is given', async () => {
    const reply = await handlerFor()({ group: everyday, name: 'Day to Day' });

    expect(reply.isError, reply.content[0]?.text).toBeFalsy();
    expect(await groupNow()).toMatchObject({ name: 'Day to Day' });
    await handlerFor()({ group: everyday, name: 'Everyday' });
  }, 60_000);

  it('renames and hides in one call', async () => {
    const reply = await handlerFor()({ group: everyday, name: 'Put Away', hidden: true });

    expect(reply.isError, reply.content[0]?.text).toBeFalsy();
    expect(await groupNow()).toMatchObject({ name: 'Put Away', hidden: true });
    await handlerFor()({ group: everyday, name: 'Everyday', hidden: false });
  }, 60_000);

  it('still refuses a call with nothing to change', async () => {
    const reply = await handlerFor()({ group: everyday });

    expect(reply.isError).toBe(true);
    expect(reply.content[0].text).toContain('No fields to update');
  }, 60_000);
});
