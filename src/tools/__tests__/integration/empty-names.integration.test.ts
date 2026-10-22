import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

vi.mock('@actual-app/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@actual-app/api')>();
  return { ...actual, sync: vi.fn().mockResolvedValue(undefined) };
});
vi.mock('../../../connection.js', () => ({
  ensureConnection: vi.fn().mockResolvedValue(undefined),
}));

import { initTestEngine, shutdownTestEngine, createFreshBudget, api } from './actual-engine.js';
import { registerCreateCategory } from '../../write/create-category.js';
import { registerUpdateCategory } from '../../write/update-category.js';
import { registerCreateCategoryGroup } from '../../write/create-category-group.js';
import { registerUpdateCategoryGroup } from '../../write/update-category-group.js';
import { registerCreatePayee } from '../../write/create-payee.js';
import { registerUpdatePayee } from '../../write/update-payee.js';

const skip = process.env.SKIP_ACTUAL_INTEGRATION === '1';

type Handler = (args: Record<string, unknown>) => Promise<{
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}>;

function handlerFor(register: (s: never) => void): Handler {
  let handler: Handler | undefined;
  register({
    tool: (...a: unknown[]) => {
      handler = a.at(-1) as Handler;
    },
  } as never);
  return handler as Handler;
}

/**
 * A name of nothing but spaces (#245).
 *
 * Measured against the engine, one call at a time: all six accept it.
 * `createCategory` and `updateCategory` store an empty name;
 * `createCategoryGroup`, `updateCategoryGroup`, `createPayee` and
 * `updatePayee` store the spaces themselves. Either way the thing is there,
 * invisible in the app, and reachable only by an id nobody wrote down, while
 * the reply says the write worked, because it did.
 */
describe.skipIf(skip)('a name that is nothing but spaces', () => {
  let group = '';
  let category = '';
  let payee = '';

  beforeAll(async () => {
    await initTestEngine();
    await createFreshBudget(async () => {
      group = await api.createCategoryGroup({ name: 'Everyday' } as never);
      category = await api.createCategory({ name: 'Groceries', group_id: group } as never);
      payee = await api.createPayee({ name: 'Shop' } as never);
    }, 'empty-names');
  }, 120_000);

  afterAll(async () => {
    await shutdownTestEngine();
  });

  const names = async () => ({
    groups: (await api.getCategoryGroups()).map((g) => g.name),
    categories: (await api.getCategories()).map((c) => c.name),
    payees: (await api.getPayees()).map((p) => p.name),
  });

  it.each([
    ['create_category', registerCreateCategory, { name: '   ', group: 'Everyday' }, 'category'],
    ['create_category_group', registerCreateCategoryGroup, { name: '  ' }, 'category group'],
    ['create_payee', registerCreatePayee, { name: ' ' }, 'payee'],
  ])('refuses it in %s, and creates nothing', async (_tool, register, args, what) => {
    const before = await names();

    const reply = await handlerFor(register as never)(args);

    expect(reply.isError).toBe(true);
    expect(reply.content[0].text).toContain(`A ${what} needs a name`);
    expect(reply.content[0].text).toContain('Nothing was created');
    expect(await names()).toEqual(before);
  }, 60_000);

  it.each([
    ['update_category', registerUpdateCategory, () => ({ category, name: '  ' }), 'category'],
    [
      'update_category_group',
      registerUpdateCategoryGroup,
      () => ({ group, name: '   ' }),
      'category group',
    ],
    ['update_payee', registerUpdatePayee, () => ({ payee, name: ' ' }), 'payee'],
  ])('refuses it in %s, and changes nothing', async (_tool, register, args, what) => {
    const before = await names();

    const reply = await handlerFor(register as never)(args());

    expect(reply.isError).toBe(true);
    expect(reply.content[0].text).toContain(`A ${what} needs a name`);
    expect(reply.content[0].text).toContain('Nothing was changed');
    expect(await names()).toEqual(before);
  }, 60_000);

  it('still accepts a name with spaces around it', async () => {
    // Refusing is about there being nothing left after the spaces, not about
    // the spaces.
    const reply = await handlerFor(registerCreateCategory)({
      name: '  Snacks  ',
      group: 'Everyday',
    });

    expect(reply.isError, reply.content[0]?.text).toBeFalsy();
    expect((await names()).categories).toContain('Snacks');
  }, 60_000);

  it('still hides a category without being given a name', async () => {
    // `update_category` sends the name it already has when only `hidden` is
    // passed, which is the workaround for actualbudget/actual#8857. A guard
    // that fired on an absent name would break it.
    const reply = await handlerFor(registerUpdateCategory)({ category, hidden: true });

    expect(reply.isError, reply.content[0]?.text).toBeUndefined();
    await handlerFor(registerUpdateCategory)({ category, hidden: false });
  }, 60_000);
});
