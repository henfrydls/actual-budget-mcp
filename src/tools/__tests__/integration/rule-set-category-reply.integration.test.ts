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

  beforeAll(async () => {
    await initTestEngine();
    await createFreshBudget(async () => {
      await api.createAccount({ name: 'Checking', offbudget: false } as never, 0);
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
