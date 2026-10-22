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
    // A zero-width space is not whitespace, so `trim()` leaves it alone and
    // it went through all six: a name one invisible character long.
    [
      'create_category with a zero-width space',
      registerCreateCategory,
      { name: '\u200b', group: 'Everyday' },
      'category',
    ],
    [
      'create_category_group with a zero-width space',
      registerCreateCategoryGroup,
      { name: ' \u200b ' },
      'category group',
    ],
    ['create_payee with a zero-width space', registerCreatePayee, { name: '\u200b\u200b' }, 'payee'],
    // The other invisible families the same rule covers.
    ['create_payee with a soft hyphen', registerCreatePayee, { name: '\u00ad' }, 'payee'],
    ['create_payee with a tab and a newline', registerCreatePayee, { name: '\t\n' }, 'payee'],
    ['create_payee with a no-break space', registerCreatePayee, { name: '\u00a0' }, 'payee'],
    // A control character that `trim()` does not touch, which is the half
    // of the rule the tabs and newlines above cannot show.
    ['create_payee with a control character', registerCreatePayee, { name: '\u0001' }, 'payee'],
    // Characters that are letters or symbols by their Unicode category and
    // render as nothing at all.
    ['create_payee with a Hangul filler', registerCreatePayee, { name: '\u3164' }, 'payee'],
    ['create_payee with a choseong filler', registerCreatePayee, { name: '\u115f' }, 'payee'],
    ['create_payee with a blank braille pattern', registerCreatePayee, { name: '\u2800' }, 'payee'],
    // Combining marks with nothing to combine with.
    ['create_payee with a grapheme joiner', registerCreatePayee, { name: '\u034f' }, 'payee'],
    ['create_payee with a variation selector', registerCreatePayee, { name: '\ufe0f' }, 'payee'],
    ['create_payee with a lone accent', registerCreatePayee, { name: '\u0301' }, 'payee'],
    // A mark that is not the first character, so taking the leading ones off
    // is not what catches it: what does is that nothing visible is left.
    ['create_payee with a space and an accent', registerCreatePayee, { name: ' \u0301' }, 'payee'],
    [
      'create_payee with accents around a space',
      registerCreatePayee,
      { name: '\u0301 \u0301' },
      'payee',
    ],
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
      'update_category with a zero-width space',
      registerUpdateCategory,
      () => ({ category, name: '\u200b' }),
      'category',
    ],
    [
      'update_payee with a zero-width space',
      registerUpdatePayee,
      () => ({ payee, name: '\u200b' }),
      'payee',
    ],
    [
      'update_category_group with a zero-width space',
      registerUpdateCategoryGroup,
      () => ({ group, name: '\u200b' }),
      'category group',
    ],
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

  it('says the name is empty rather than calling nothing spaces', async () => {
    const reply = await handlerFor(registerCreatePayee)({ name: '' });

    expect(reply.isError).toBe(true);
    expect(reply.content[0].text).toContain('this one is empty');
    expect(reply.content[0].text).not.toContain('""');
  });

  it('shows a tab and a newline as escapes, not as a tab and a newline', async () => {
    // A message that contains the characters it is complaining about is as
    // unreadable as the name.
    const reply = await handlerFor(registerCreatePayee)({ name: '\t\n' });

    expect(reply.isError).toBe(true);
    expect(reply.content[0].text).toContain('"\\t\\n" has nothing visible in it');
    expect(reply.content[0].text).not.toContain('\t');
    expect(reply.content[0].text).not.toContain('\n\n');
  });

  it('shows an invisible character by its code point', async () => {
    const reply = await handlerFor(registerCreatePayee)({ name: '\u200b' });

    expect(reply.isError).toBe(true);
    expect(reply.content[0].text).toContain('\\u200b');
  });

  it('keeps a name whose marks and emoji are the point of it', async () => {
    // The rule takes combining marks out before asking whether anything is
    // left, so it has to leave them in the name itself: an accent over a
    // letter is part of the name, and a variation selector is part of an
    // emoji.
    const accented = await handlerFor(registerCreatePayee)({ name: 'Cafe\u0301 Luna' });
    // The accent at the very end, which is where trimming marks off the
    // edges would eat it.
    const ending = await handlerFor(registerCreatePayee)({ name: 'Cafe\u0301' });
    const emoji = await handlerFor(registerCreatePayee)({ name: '\u{1f642} Corner' });

    expect(accented.isError, accented.content[0]?.text).toBeFalsy();
    expect(emoji.isError, emoji.content[0]?.text).toBeFalsy();
    const stored = await names();
    expect(ending.isError, ending.content[0]?.text).toBeFalsy();
    expect(stored.payees).toContain('Cafe\u0301 Luna');
    expect(stored.payees).toContain('Cafe\u0301');
    expect(stored.payees).toContain('\u{1f642} Corner');
  }, 60_000);

  it('takes invisible padding off a real name', async () => {
    // `trim()` leaves a zero-width space where it finds one, so this was
    // stored with its padding: a name nobody can type.
    const reply = await handlerFor(registerCreatePayee)({ name: '\u200bBakery\u200b' });

    expect(reply.isError, reply.content[0]?.text).toBeFalsy();
    expect(reply.content[0].text).toContain('Name: Bakery');
    const stored = await names();
    expect(stored.payees).toContain('Bakery');
    expect(stored.payees.some((n) => n.includes('\u200b'))).toBe(false);
  }, 60_000);

  it('stores the name without the padding a person leaves on it', async () => {
    // The engine trims a category's name and does not trim a payee's or a
    // group's: measured, four of the six stored "  Padded  " as it came.
    const payeeReply = await handlerFor(registerCreatePayee)({ name: '  Corner Shop  ' });
    const groupReply = await handlerFor(registerCreateCategoryGroup)({ name: ' Set Aside ' });

    expect(payeeReply.isError, payeeReply.content[0]?.text).toBeFalsy();
    expect(groupReply.isError, groupReply.content[0]?.text).toBeFalsy();
    const stored = await names();
    expect(stored.payees).toContain('Corner Shop');
    expect(stored.payees).not.toContain('  Corner Shop  ');
    expect(stored.groups).toContain('Set Aside');
    expect(stored.groups).not.toContain(' Set Aside ');
    // And the reply says what was stored, not what was typed.
    expect(payeeReply.content[0].text).toContain('Name: Corner Shop');
    expect(payeeReply.content[0].text).not.toContain('  Corner Shop  ');
    expect(groupReply.content[0].text).toContain('Name: Set Aside');
  }, 60_000);

  it('renames a group to the trimmed name, and says that', async () => {
    // The group half was validated and then written as it came, so the
    // padding went into the budget while the check had already seen it.
    const renamed = await handlerFor(registerUpdateCategoryGroup)({
      group: 'Everyday',
      name: '  Day to Day  ',
    });

    expect(renamed.isError, renamed.content[0]?.text).toBeFalsy();
    expect(renamed.content[0].text).toContain('Day to Day');
    expect(renamed.content[0].text).not.toContain('  Day to Day  ');
    const stored = await names();
    expect(stored.groups).toContain('Day to Day');
    expect(stored.groups.some((n) => n !== n.trim())).toBe(false);
    await handlerFor(registerUpdateCategoryGroup)({ group: 'Day to Day', name: 'Everyday' });
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
