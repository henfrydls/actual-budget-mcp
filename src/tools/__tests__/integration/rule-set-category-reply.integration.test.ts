import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

vi.mock('@actual-app/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@actual-app/api')>();
  return { ...actual, sync: vi.fn().mockResolvedValue(undefined) };
});
vi.mock('../../../connection.js', () => ({
  ensureConnection: vi.fn().mockResolvedValue(undefined),
}));

import { initTestEngine, shutdownTestEngine, createFreshBudget, api } from './actual-engine.js';
import { createTransaction } from '../../write/create-transaction.js';

const skip = process.env.SKIP_ACTUAL_INTEGRATION === '1';

/**
 * Saying what a rule did to the transaction that was just recorded.
 *
 * Found while testing 0.10.4 against a real budget. A transaction recorded
 * without a category came back with no mention of one, and a rule had given it
 * one: the reply read as if nothing had been categorised, and the category
 * turned up later in a report, which is where a wrong rule is expensive to
 * find.
 *
 * Measured against the engine first: a rule's category is on the row in the
 * first read after the write, so the reply does not have to wait for anything
 * to settle.
 */
describe.skipIf(skip)('what a rule did, in the reply', () => {
  let categoryId = '';
  let payeeId = '';
  let accountId = '';

  beforeAll(async () => {
    await initTestEngine();
    await createFreshBudget(async () => {
      accountId = (await api.createAccount({ name: 'Checking', offbudget: false } as never, 0)) as string;
      const group = await api.createCategoryGroup({ name: 'Spending' } as never);
      categoryId = (await api.createCategory({ name: 'Fun', group_id: group } as never)) as string;
      await api.createCategory({ name: 'Bills', group_id: group } as never);
      payeeId = (await api.createPayee({ name: 'Cinema' } as never)) as string;
    }, 'rule-category-reply');

    await api.createRule({
      stage: null,
      conditionsOp: 'and',
      conditions: [{ op: 'is', field: 'payee', value: payeeId }],
      actions: [{ op: 'set', field: 'category', value: categoryId }],
    } as never);
  }, 60_000);

  afterAll(async () => {
    await shutdownTestEngine();
  });

  it('names the category a rule set, and says a rule set it', async () => {
    const lines = await createTransaction({
      account: 'Checking',
      amount: -15,
      payee: 'Cinema',
      date: '2026-10-12',
    } as never);
    const text = lines.join('\n');

    expect(text).toContain('Fun');
    expect(text, 'a rule choosing it is not the same as asking for it').toMatch(/rule/i);
  });

  it('says a rule split the row instead of calling it uncategorised', async () => {
    // A rule can split the transaction rather than categorise it, and the
    // parent of a split holds no category, so "uncategorised" is the wrong
    // word for it too.
    await api.createRule({
      stage: null,
      conditionsOp: 'and',
      conditions: [{ op: 'is', field: 'notes', value: 'split-me' }],
      actions: [
        {
          op: 'set-split-amount',
          value: 50,
          options: { splitIndex: 1, method: 'remainder' },
        },
      ],
    } as never);

    const lines = await createTransaction({
      account: 'Checking',
      amount: -77,
      payee: 'Nobody In Particular',
      notes: 'split-me',
      date: '2026-10-12',
    } as never);
    const text = lines.join('\n');

    // The sentence, not the word: the notes say "split-me", so /split/ passes
    // whether or not the line is there at all.
    expect(text).toContain('A rule split this into parts');
    expect(text, 'the parts hold the category, so naming one here would be wrong').not.toMatch(
      /set by one of your rules/,
    );
  });

  it('says where it counts when a rule categorised a transfer out of the budget', async () => {
    // The reply used to say "Give the row in Checking a category to say where
    // it counts" right after announcing the category a rule had just set,
    // which asks for something already done.
    await api.createAccount({ name: 'Savings', offbudget: true } as never, 0);
    await api.createPayee({ name: 'Savings' } as never).catch(() => undefined);
    await api.createRule({
      stage: null,
      conditionsOp: 'and',
      conditions: [{ op: 'is', field: 'notes', value: 'to-savings' }],
      actions: [{ op: 'set', field: 'category', value: categoryId }],
    } as never);

    const lines = await createTransaction({
      account: 'Checking',
      amount: -88,
      payee: 'Savings',
      notes: 'to-savings',
      date: '2026-10-12',
    } as never);
    const text = lines.join('\n');

    // Where it counts, in full. Asserting only that "Give the row a
    // category" is absent passes on any other wording, including the one for
    // a category that does not count.
    expect(text).toContain('It counts in Checking, under Fun (set by one of your rules).');
    expect(text, 'it asked for a category that was already there').not.toMatch(
      /Give the row in .* a category/,
    );
  });

  it('says nothing about a category when no rule touched it', async () => {
    // The quiet case has to stay quiet, or every uncategorised transaction
    // starts carrying a line about rules.
    const lines = await createTransaction({
      account: 'Checking',
      amount: -22,
      payee: 'Nobody In Particular',
      date: '2026-10-12',
    } as never);

    expect(lines.join('\n')).not.toMatch(/Category:/);
  });

  it('still says the transaction was created when the lookup fails', async () => {
    // The write has already happened by then. `getCategories` throwing landed
    // in the catch that decides a failed write may not have been applied, so
    // the reply said Error, skipped the sync, and the row was sitting in the
    // budget with its category the whole time. Measured that way before the
    // fix, with the read rejecting.
    vi.mocked(api.sync).mockClear();
    const real = api.getCategories;
    (api as { getCategories: unknown }).getCategories = async () => {
      throw new Error('database is locked');
    };
    try {
      const lines = await createTransaction({
        account: 'Checking',
        amount: -44,
        payee: 'Cinema',
        date: '2026-10-12',
      } as never);
      const text = lines.join('\n');

      // The line itself. The other half of what this used to accept,
      // "Checking", is the account from the input and comes back in
      // `Account: Checking` whatever happened, so that alternative passed on
      // its own and the assertion could not fail.
      expect(text, 'the transaction was recorded, so the reply must say so').toContain(
        'Transaction created:',
      );
      // And it keeps quiet about the category rather than guessing.
      expect(text).not.toMatch(/set by one of your rules/);

      // The sync is the other thing the old path skipped, and it is not
      // visible in the reply at all.
      expect(vi.mocked(api.sync), 'the write was not synced').toHaveBeenCalled();
    } finally {
      (api as { getCategories: unknown }).getCategories = real;
    }

    // The row really is there, which is what made the old reply a lie.
    let rows: { amount: number }[] = [];
    for (let attempt = 0; attempt < 8; attempt += 1) {
      rows = (await api.getTransactions(accountId, '2000-01-01', '2100-01-01')) as never;
      if (rows.some((r) => r.amount === -4400)) break;
    }
    expect(rows.map((r) => r.amount), 'the write did happen').toContain(-4400);
  });

  it('still reports the category that was asked for as the caller asked for it', async () => {
    // An explicit category wins over the rule (#26), and it is the caller's
    // choice, so it is not announced as a rule's doing.
    const lines = await createTransaction({
      account: 'Checking',
      amount: -31,
      payee: 'Cinema',
      category: 'Bills',
      date: '2026-10-12',
    } as never);
    const text = lines.join('\n');

    expect(text).toContain('Category: Bills');
    expect(text).not.toMatch(/set by one of your rules/);
  });
});
