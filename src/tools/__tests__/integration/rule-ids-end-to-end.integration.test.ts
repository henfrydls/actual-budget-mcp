import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

vi.mock('@actual-app/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@actual-app/api')>();
  return { ...actual, sync: vi.fn().mockResolvedValue(undefined) };
});
vi.mock('../../../connection.js', () => ({
  ensureConnection: vi.fn().mockResolvedValue(undefined),
}));

import { initTestEngine, shutdownTestEngine, createFreshBudget, api } from './actual-engine.js';
import { createRuleFromInput } from '../../write/create-rule.js';

const skip = process.env.SKIP_ACTUAL_INTEGRATION === '1';

/**
 * Rules built from names, judged by what they do to a transaction (#170, #171).
 *
 * The reply said "Rule created" before any of this worked, and the rule then
 * matched nothing, so the only assertion worth making is whether a
 * transaction that should be caught ends up categorised.
 */
describe.skipIf(skip)('a rule written with names', () => {
  let checking = '';
  let savings = '';
  let groceries = '';
  let fun = '';
  let netflix = '';

  beforeAll(async () => {
    await initTestEngine();
  }, 60_000);

  afterAll(async () => {
    await shutdownTestEngine();
  });

  async function budget(name: string) {
    await createFreshBudget(async () => {
      checking = await api.createAccount({ name: 'Checking', offbudget: false } as never, 0);
      savings = await api.createAccount({ name: 'Savings', offbudget: false } as never, 0);
      netflix = await api.createPayee({ name: 'Netflix' } as never);
      await api.createPayee({ name: 'Spotify' } as never);
      const spending = await api.createCategoryGroup({ name: 'Spending' } as never);
      groceries = await api.createCategory({ name: 'Groceries', group_id: spending } as never);
      fun = await api.createCategory({ name: 'Fun', group_id: spending } as never);
    }, name);
    for (let i = 0; i < 4; i += 1) await api.getCategories();
  }

  // A distinct amount per row. `importTransactions` matches an incoming row
  // against what is already there by amount and a date window, so a second
  // -25.00 a day later is taken for the same movement and never lands, which
  // reads in a test exactly like a rule that did not fire.
  let nextAmount = -1000;
  const importInto = async (account: string, date: string, payeeName: string) => {
    nextAmount -= 137;
    await api.importTransactions(account, [
      { date, amount: nextAmount, payee_name: payeeName },
    ] as never);
    for (let i = 0; i < 4; i += 1) await api.getCategories();
    const rows = (await api.getTransactions(account, date, date)) as Array<Record<string, unknown>>;
    return rows[0];
  };

  it('catches a transaction on the account it names (#170)', async () => {
    // `account is "Checking"` used to store the name and match nothing.
    await budget('rule-account-name');

    await createRuleFromInput({
      condition_field: 'account',
      condition_op: 'is',
      condition_value: 'Checking',
      action_field: 'category',
      action_value: 'Groceries',
    });

    const caught = await importInto(checking, '2026-09-01', 'Anyone');
    expect(caught?.category, 'the rule did not catch its own account').toBe(groceries);

    const elsewhere = await importInto(savings, '2026-09-02', 'Anyone');
    expect(elsewhere?.category ?? null, 'it caught another account too').toBeNull();
  }, 60_000);

  it('catches transactions from any payee in a list (#171)', async () => {
    await budget('rule-oneof-payee');

    await createRuleFromInput({
      condition_field: 'payee',
      condition_op: 'oneOf',
      condition_value: ['Netflix', 'Spotify'],
      action_field: 'category',
      action_value: 'Fun',
    });

    for (const [day, payee] of [['03', 'Netflix'], ['04', 'Spotify']] as const) {
      const row = await importInto(checking, `2026-09-${day}`, payee);
      expect(row?.category, `${payee} was not caught`).toBe(fun);
    }

    const other = await importInto(checking, '2026-09-05', 'Someone Else');
    expect(other?.category ?? null, 'it caught a payee outside the list').toBeNull();
  }, 60_000);

  it('stores the list as ids, which is what the engine compares', async () => {
    await budget('rule-oneof-ids');

    const lines = await createRuleFromInput({
      condition_field: 'payee',
      condition_op: 'oneOf',
      condition_value: ['Netflix'],
      action_field: 'category',
      action_value: 'Fun',
    });
    const id = lines.find((l) => l.includes('ID:'))!.split('ID:')[1].trim();
    const stored = (await api.getRules()).find((r) => r.id === id) as
      | { conditions: Array<{ value: unknown }> }
      | undefined;

    expect(stored?.conditions[0].value).toEqual([netflix]);
  }, 60_000);

  it('takes one value for oneOf and makes it a list of one', async () => {
    // What a caller passing a single string meant. It used to fail outright,
    // with a bare "Failed creating a new rule" from the engine.
    await budget('rule-oneof-single');

    const lines = await createRuleFromInput({
      condition_field: 'payee',
      condition_op: 'oneOf',
      condition_value: 'Netflix',
      action_field: 'category',
      action_value: 'Fun',
    });
    const id = lines.find((l) => l.includes('ID:'))!.split('ID:')[1].trim();
    const stored = (await api.getRules()).find((r) => r.id === id) as
      | { conditions: Array<{ value: unknown }> }
      | undefined;

    expect(stored?.conditions[0].value).toEqual([netflix]);
    expect((await importInto(checking, '2026-09-06', 'Netflix'))?.category).toBe(fun);
  }, 60_000);

  it('catches a category group by name', async () => {
    await budget('rule-group-name');

    await createRuleFromInput({
      condition_field: 'category_group',
      condition_op: 'is',
      condition_value: 'Spending',
      action_field: 'notes',
      action_value: 'in spending',
    });

    await api.importTransactions(checking, [
      { date: '2026-09-07', amount: -9191, payee_name: 'Anyone', category: fun },
    ] as never);
    for (let i = 0; i < 4; i += 1) await api.getCategories();
    const rows = (await api.getTransactions(checking, '2026-09-07', '2026-09-07')) as Array<
      Record<string, unknown>
    >;
    expect(rows[0]?.notes).toBe('in spending');
  }, 60_000);

  it('refuses a list with one unusable name, and saves nothing', async () => {
    // Half a list quietly saved is a rule that does part of what was asked.
    await budget('rule-oneof-bad');
    const before = (await api.getRules()).length;

    await expect(
      createRuleFromInput({
        condition_field: 'payee',
        condition_op: 'oneOf',
        condition_value: ['Netflix', 'Nowhere'],
        action_field: 'category',
        action_value: 'Fun',
      }),
    ).rejects.toThrow(/No payee found matching "Nowhere"/);

    expect((await api.getRules()).length).toBe(before);
  }, 60_000);

  it('refuses an unknown account name, and an ambiguous one', async () => {
    await budget('rule-account-bad');

    await expect(
      createRuleFromInput({
        condition_field: 'account',
        condition_op: 'is',
        condition_value: 'Nowhere',
        action_field: 'category',
        action_value: 'Groceries',
      }),
    ).rejects.toThrow(/No account found matching "Nowhere"/);

    // Actual allows two accounts to share a name, and then neither can be
    // resolved by it.
    await api.createAccount({ name: 'Savings', offbudget: true } as never, 0);
    for (let i = 0; i < 4; i += 1) await api.getCategories();

    await expect(
      createRuleFromInput({
        condition_field: 'account',
        condition_op: 'is',
        condition_value: 'Savings',
        action_field: 'category',
        action_value: 'Groceries',
      }),
    ).rejects.toThrow(/Ambiguous account name "Savings"/);
  }, 60_000);

  it('takes a list on a field that is not an id either', async () => {
    // The list handling is not only for the id fields: `imported_payee oneOf`
    // is a text field with several values, and it used to go out as one
    // string and be rejected by the engine.
    await budget('rule-oneof-text');

    const lines = await createRuleFromInput({
      condition_field: 'imported_payee',
      condition_op: 'oneOf',
      condition_value: ['FRESHMART', 'CORNER SHOP'],
      action_field: 'category',
      action_value: 'Groceries',
    });
    const id = lines.find((l) => l.includes('ID:'))!.split('ID:')[1].trim();
    const stored = (await api.getRules()).find((r) => r.id === id) as
      | { conditions: Array<{ value: unknown }> }
      | undefined;

    expect(stored?.conditions[0].value).toEqual(['FRESHMART', 'CORNER SHOP']);
    expect((await importInto(checking, '2026-09-08', 'FRESHMART'))?.category).toBe(groceries);
  }, 60_000);

  it('makes a list of one out of a single value there too', async () => {
    await budget('rule-oneof-text-single');

    const lines = await createRuleFromInput({
      condition_field: 'imported_payee',
      condition_op: 'oneOf',
      condition_value: 'FRESHMART',
      action_field: 'category',
      action_value: 'Groceries',
    });
    const id = lines.find((l) => l.includes('ID:'))!.split('ID:')[1].trim();
    const stored = (await api.getRules()).find((r) => r.id === id) as
      | { conditions: Array<{ value: unknown }> }
      | undefined;

    expect(stored?.conditions[0].value).toEqual(['FRESHMART']);
  }, 60_000);

  it('cannot name a closed account, and says why rather than talking about names', async () => {
    // Measured: a closed account comes back from neither `getAccounts()` nor
    // a query, so it is unreachable from here by name and by id. The engine
    // would accept such a rule, but nothing in the public API can name the
    // account to build it, and a message about whole names reads as nonsense
    // next to a UUID.
    await budget('rule-closed-account');
    const old = await api.createAccount({ name: 'Old Card', offbudget: false } as never, 0);
    await api.closeAccount(old as never);
    for (let i = 0; i < 4; i += 1) await api.getCategories();

    await expect(
      createRuleFromInput({
        condition_field: 'account',
        condition_op: 'is',
        condition_value: 'Old Card',
        action_field: 'category',
        action_value: 'Groceries',
      }),
    ).rejects.toThrow(/No account found matching "Old Card"/);

    await expect(
      createRuleFromInput({
        condition_field: 'account',
        condition_op: 'is',
        condition_value: old,
        action_field: 'category',
        action_value: 'Groceries',
      }),
    ).rejects.toThrow(/No account with the id[\s\S]*closed/);
  }, 60_000);

  it('reads like English whichever field it is talking about', async () => {
    // The message is built from the field name, and "A account" was reaching
    // users.
    await budget('rule-article');

    const message = await createRuleFromInput({
      condition_field: 'account',
      condition_op: 'is',
      condition_value: 'Nowhere',
      action_field: 'category',
      action_value: 'Groceries',
    }).catch((e: Error) => e.message);

    expect(message).toContain('An account is matched');
    expect(message).not.toContain('A account');
  }, 60_000);

  it('refuses a list where a single value is expected', async () => {
    await budget('rule-list-wrong-op');

    await expect(
      createRuleFromInput({
        condition_field: 'payee',
        condition_op: 'is',
        condition_value: ['Netflix', 'Spotify'],
        action_field: 'category',
        action_value: 'Fun',
      }),
    ).rejects.toThrow(/takes one value, not a list/);
  }, 60_000);
});
