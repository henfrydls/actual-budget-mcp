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
 * The reply describes the transaction that was saved, not the one that was
 * asked for (#184).
 *
 * Actual runs the rules on every insert, so the row that lands can differ from
 * the row that was sent. Until now one line of the reply, the category, read
 * the row and the rest read the request: a rule that set `amount` left a
 * transaction of -5.50 in the budget and a reply that said -4.40, which is how
 * this was found, in the live test of 0.10.5.
 *
 * Every rule here changes exactly one field, so a test that goes red names the
 * field that stopped being read.
 */
describe.skipIf(skip)('what the saved row says, in the reply', () => {
  let checkingId = '';
  let savingsId = '';
  let otherId = '';

  beforeAll(async () => {
    await initTestEngine();
    await createFreshBudget(async () => {
      checkingId = (await api.createAccount(
        { name: 'Checking', offbudget: false } as never,
        0,
      )) as string;
      otherId = (await api.createAccount({ name: 'Other', offbudget: false } as never, 0)) as string;
      savingsId = (await api.createAccount({ name: 'Savings', offbudget: true } as never, 0)) as string;
      const group = await api.createCategoryGroup({ name: 'Spending' } as never);
      await api.createCategory({ name: 'Fun', group_id: group } as never);
      await api.createPayee({ name: 'Theatre' } as never);
    }, 'rule-rewrites-reply');

    const theatre = (await api.getPayees()).find((p) => p.name === 'Theatre')!.id;
    const rule = async (notes: string, actions: unknown[]) =>
      api.createRule({
        stage: null,
        conditionsOp: 'and',
        conditions: [{ op: 'is', field: 'notes', value: notes }],
        actions,
      } as never);

    await rule('amount-me', [{ op: 'set', field: 'amount', value: -550 }]);
    await rule('date-me', [{ op: 'set', field: 'date', value: '2026-01-05' }]);
    await rule('payee-me', [{ op: 'set', field: 'payee', value: theatre }]);
    await rule('clear-me', [{ op: 'set', field: 'cleared', value: true }]);
    // Two actions on purpose: without the second one, a rule that never
    // matched and an engine that ignores `set account` look exactly the same
    // from the outside, and the test would pass for the wrong reason.
    await rule('move-me', [
      { op: 'set', field: 'account', value: otherId },
      { op: 'set', field: 'cleared', value: true },
    ]);
    await rule('xfer-me', [{ op: 'set', field: 'payee', value: theatre }]);
    await rule('split-me', [
      { op: 'set-split-amount', value: 50, options: { splitIndex: 1, method: 'remainder' } },
    ]);
    // The notes rule is keyed on the payee, since a rule keyed on the notes
    // would be deciding what it reads.
    await api.createRule({
      stage: null,
      conditionsOp: 'and',
      conditions: [{ op: 'is', field: 'payee', value: theatre }],
      actions: [{ op: 'prepend-notes', value: 'PRE ' }],
    } as never);
  }, 120_000);

  afterAll(async () => {
    await shutdownTestEngine();
  });

  const rowsIn = async (accountId: string) =>
    (await api.getTransactions(accountId, '2000-01-01', '2100-01-01')) as Array<{
      amount: number;
      notes?: string | null;
    }>;

  it('prints the amount the budget holds, and the one that was asked for', async () => {
    const lines = await createTransaction({
      account: 'Checking',
      amount: -4.4,
      payee: 'Shop',
      notes: 'amount-me',
      date: '2026-10-12',
    } as never);
    const text = lines.join('\n');

    // The whole line. Asserting only that -5.50 appears would pass on a reply
    // that printed both figures without saying which one is in the budget.
    expect(text).toContain('Amount:   -5.50 (set by one of your rules, asked for -4.40)');
    expect(text).not.toMatch(/Amount: {3}-4\.40$/m);
    expect((await rowsIn(checkingId)).map((r) => r.amount)).toContain(-550);
  });

  it('prints the date the budget holds', async () => {
    const lines = await createTransaction({
      account: 'Checking',
      amount: -11,
      payee: 'Shop',
      notes: 'date-me',
      date: '2026-10-12',
    } as never);

    expect(lines.join('\n')).toContain(
      'Date:     2026-01-05 (set by one of your rules, asked for 2026-10-12)',
    );
  });

  it('prints the payee the budget holds', async () => {
    const lines = await createTransaction({
      account: 'Checking',
      amount: -12,
      payee: 'Cinema',
      notes: 'payee-me',
      date: '2026-10-12',
    } as never);

    expect(lines.join('\n')).toContain(
      'Payee:    Theatre (set by one of your rules, asked for Cinema)',
    );
  });

  it('prints the notes the budget holds', async () => {
    const lines = await createTransaction({
      account: 'Checking',
      amount: -13,
      payee: 'Theatre',
      notes: 'mine',
      date: '2026-10-12',
    } as never);

    expect(lines.join('\n')).toContain(
      'Notes:    PRE mine (set by one of your rules, asked for mine)',
    );
  });

  it('says a rule cleared it, and says nothing when no rule did', async () => {
    const cleared = await createTransaction({
      account: 'Checking',
      amount: -14,
      payee: 'Shop',
      notes: 'clear-me',
      date: '2026-10-12',
    } as never);

    expect(cleared.join('\n')).toContain('Cleared:  yes (set by one of your rules, asked for no)');

    const quiet = await createTransaction({
      account: 'Checking',
      amount: -15,
      payee: 'Shop',
      date: '2026-10-12',
    } as never);

    // Nothing has ever printed whether a transaction is cleared, and a line
    // on every reply saying "no" would be noise.
    expect(quiet.join('\n')).not.toMatch(/Cleared:/);
    expect(quiet.join('\n')).not.toMatch(/set by one of your rules/);
  });

  it('cannot be moved to another account by a rule, so the account is the one asked for', async () => {
    // Measured against the engine rather than assumed: `addTransactions`
    // builds the row it inserts as `{ id, ...trans, account: acctId }`, so the
    // account argument is written over whatever the rule chose. This is the
    // guard that holds the engine to it; if it ever goes red, the reply has to
    // start reading the account off the row like everything else.
    const lines = await createTransaction({
      account: 'Checking',
      amount: -16,
      payee: 'Shop',
      notes: 'move-me',
      date: '2026-10-12',
    } as never);

    const text = lines.join('\n');
    expect(text).toContain('Account:  Checking');
    // The rule did fire: this is the half of it the engine honours.
    expect(text).toContain('Cleared:  yes (set by one of your rules, asked for no)');
    expect((await rowsIn(checkingId)).map((r) => r.amount)).toContain(-1600);
    expect((await rowsIn(otherId)).map((r) => r.amount)).not.toContain(-1600);
  });

  it('does not announce a transfer a rule stopped from happening', async () => {
    // A rule that rewrites the payee leaves the row pointing somewhere else,
    // and nothing is written in the other account. The reply announced the
    // transfer, a matching row and what it did to the budget, none of which
    // had happened.
    const lines = await createTransaction({
      account: 'Checking',
      amount: -17,
      payee: 'Savings',
      notes: 'xfer-me',
      date: '2026-10-12',
    } as never);
    const text = lines.join('\n');

    expect(text).toContain('Transaction created:');
    expect(text).not.toContain('Transfer created:');
    expect(text).not.toContain('A matching row was created there.');
    expect(text).toContain('Payee:    Theatre (set by one of your rules, asked for Savings)');
    expect(text).toContain('nothing was created in Savings');
    // And the other account really is empty, which is what made the old reply
    // a lie rather than a wording problem.
    expect((await rowsIn(savingsId)).map((r) => r.amount)).not.toContain(1700);
  });

  it('still announces a transfer no rule touched', async () => {
    const lines = await createTransaction({
      account: 'Checking',
      amount: -18,
      payee: 'Savings',
      date: '2026-10-12',
    } as never);
    const text = lines.join('\n');

    expect(text).toContain('Transfer created:');
    expect(text).toContain('A matching row was created there.');
    expect((await rowsIn(savingsId)).map((r) => r.amount)).toContain(1800);
  });

  it('does not report a split as a rule having removed the payee', async () => {
    // A split parent carries no payee: the parts hold it. Reading the parent
    // without knowing that turns every split into "a rule removed your payee".
    const lines = await createTransaction({
      account: 'Checking',
      amount: -19,
      payee: 'Shop',
      notes: 'split-me',
      date: '2026-10-12',
    } as never);
    const text = lines.join('\n');

    expect(text).toContain('Payee:    Shop');
    expect(text).not.toMatch(/Payee:.*set by one of your rules/);
    expect(text).toContain('A rule split this into parts');
  });

  it('does not print a category a split was never given', async () => {
    // Actual keeps no category on a split parent, so the one that was asked
    // for was not applied. The reply printed it anyway and said so only on
    // stderr, where the caller never looks.
    const lines = await createTransaction({
      account: 'Checking',
      amount: -25,
      payee: 'Shop',
      category: 'Fun',
      notes: 'split-me',
      date: '2026-10-12',
    } as never);
    const text = lines.join('\n');

    expect(text).not.toContain('Category: Fun');
    expect(text).toContain('the category you asked for was not applied');
  });
});
