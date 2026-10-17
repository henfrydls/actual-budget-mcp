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
import { createTransactions } from '../../write/create-transactions.js';

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
  let cashId = '';

  beforeAll(async () => {
    await initTestEngine();
    await createFreshBudget(async () => {
      checkingId = (await api.createAccount(
        { name: 'Checking', offbudget: false } as never,
        0,
      )) as string;
      otherId = (await api.createAccount({ name: 'Other', offbudget: false } as never, 0)) as string;
      savingsId = (await api.createAccount({ name: 'Savings', offbudget: true } as never, 0)) as string;
      cashId = (await api.createAccount({ name: 'Cash', offbudget: true } as never, 0)) as string;
      const group = await api.createCategoryGroup({ name: 'Spending' } as never);
      await api.createCategory({ name: 'Fun', group_id: group } as never);
      await api.createCategory({ name: 'Bills', group_id: group } as never);
      await api.createPayee({ name: 'Theatre' } as never);
    }, 'rule-rewrites-reply');

    const payees = await api.getPayees();
    const theatre = payees.find((p) => p.name === 'Theatre')!.id;
    // The payee Actual uses for transfers into Other, which is what links the
    // two rows of a transfer. A rule can put it on any transaction.
    const otherTransferPayee = payees.find((p) => p.transfer_acct === otherId)!.id;
    const bills = (await api.getCategories()).find((c) => c.name === 'Bills')!.id;
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
    await rule('split-payee', [
      { op: 'set-split-amount', value: 50, options: { splitIndex: 1, method: 'remainder' } },
      { op: 'set', field: 'payee', value: theatre },
    ]);
    await rule('split-cat', [
      { op: 'set-split-amount', value: 50, options: { splitIndex: 1, method: 'remainder' } },
      { op: 'set', field: 'category', value: bills, options: { splitIndex: 1 } },
    ]);
    await rule('to-other', [{ op: 'set', field: 'payee', value: otherTransferPayee }]);
    await rule('split-xfer', [
      { op: 'set-split-amount', value: 50, options: { splitIndex: 1, method: 'remainder' } },
    ]);
    // Two parts, and the second one pointed at another account, so one
    // transaction leaves the budget on one side and stays inside it on the
    // other.
    await rule('split-two-ways', [
      { op: 'set-split-amount', value: 50, options: { splitIndex: 1, method: 'fixed-percent' } },
      { op: 'set-split-amount', value: 0, options: { splitIndex: 2, method: 'remainder' } },
      { op: 'set', field: 'payee', value: otherTransferPayee, options: { splitIndex: 2 } },
    ]);
    // Two parts, and a payee on one of them only, so the parts disagree.
    await rule('split-two-payees', [
      { op: 'set-split-amount', value: 50, options: { splitIndex: 1, method: 'fixed-percent' } },
      { op: 'set-split-amount', value: 0, options: { splitIndex: 2, method: 'remainder' } },
      { op: 'set', field: 'payee', value: theatre, options: { splitIndex: 1 } },
    ]);
    await rule('split-to-other', [
      { op: 'set-split-amount', value: 50, options: { splitIndex: 1, method: 'remainder' } },
      { op: 'set', field: 'payee', value: otherTransferPayee, options: { splitIndex: 1 } },
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

  /** Count what the tool writes while it runs, without changing what it does. */
  async function countingUpdates<T>(run: () => Promise<T>): Promise<{ result: T; updates: number }> {
    const real = api.updateTransaction;
    let updates = 0;
    (api as { updateTransaction: unknown }).updateTransaction = async (...args: unknown[]) => {
      updates += 1;
      return (real as (...a: unknown[]) => Promise<unknown>)(...args);
    };
    try {
      return { result: await run(), updates };
    } finally {
      (api as { updateTransaction: unknown }).updateTransaction = real;
    }
  }

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
    //
    // Only this route. The same rule moves a transaction that arrives through
    // an import or a bank sync, which `rule-sets-account` measures.
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
    expect(text).toContain('A rule split this into 1 part');
  });

  it('names the payee a rule put on the parts of a split', async () => {
    // The parent of a split carries no payee, so reading it reported the one
    // that had been asked for and said nothing. The parts carry it, and a
    // rule can change it there.
    const lines = await createTransaction({
      account: 'Checking',
      amount: -26,
      payee: 'Shop',
      notes: 'split-payee',
      date: '2026-10-12',
    } as never);

    expect(lines.join('\n')).toContain(
      'Payee:    Theatre (set by one of your rules, asked for Shop)',
    );
  });

  it('says which categories the parts of a split carry', async () => {
    // The reply, and the stderr warning before it, said the category asked
    // for had not been applied. Measured against the engine, it is applied:
    // the engine copies the parent's category onto every part. The parent is
    // simply the wrong row to read it from.
    const lines = await createTransaction({
      account: 'Checking',
      amount: -25,
      payee: 'Shop',
      category: 'Fun',
      notes: 'split-me',
      date: '2026-10-12',
    } as never);
    const text = lines.join('\n');

    expect(text).toContain('A rule split this into 1 part, under Fun.');
    expect(text, 'it was applied, to the part').not.toMatch(/was not applied/);
    // And the part really has it, which is what made the old sentence false.
    // `getTransactions` hands back parents with their parts nested, so the
    // part is read from there rather than as a row of its own.
    const parent = (await rowsIn(checkingId)).find((r) => r.amount === -2500) as unknown as {
      subtransactions?: Array<{ category?: string | null }>;
    };
    expect(parent?.subtransactions?.every((part) => Boolean(part.category))).toBe(true);
  });

  it('says which category a part carries when a rule gives it its own', async () => {
    // A rule that sets a category on a part wins there, so "under Fun" would
    // be false for that part. Forcing the asked category back onto it would
    // undo the rule, which is why nothing is forced on a split.
    const lines = await createTransaction({
      account: 'Checking',
      amount: -27,
      payee: 'Shop',
      category: 'Fun',
      notes: 'split-cat',
      date: '2026-10-12',
    } as never);

    // And named as the rule's doing, not as the category that was asked for.
    expect(lines.join('\n')).toContain(
      'A rule split this into 1 part, under Bills (set by your rules).',
    );
  });

  it('names the account a rule sent the transfer to, not the one asked for', async () => {
    // A rule can put another account's transfer payee on the row, and the
    // engine links the transfer there. The reply named the account that had
    // been asked for, said a matching row was in it, and called a movement
    // inside the budget a departure from it.
    const lines = await createTransaction({
      account: 'Checking',
      amount: -28,
      payee: 'Savings',
      notes: 'to-other',
      date: '2026-10-12',
    } as never);
    const text = lines.join('\n');

    expect(text).toContain('Transfer to: Other (set by one of your rules, asked for Savings)');
    expect(text, 'Other is on budget, so this is not money leaving it').toContain(
      'The money moved between accounts inside your budget',
    );
    expect(text).not.toContain('Savings is off budget');
    // The matching row is in Other, which is what made the old reply false.
    expect((await rowsIn(otherId)).map((r) => r.amount)).toContain(2800);
    expect((await rowsIn(savingsId)).map((r) => r.amount)).not.toContain(2800);
  });

  it('says when a rule leaves an ordinary row pointing at an account', async () => {
    // The payee is the one Actual uses for transfers into Other, but nothing
    // asked for a transfer, so no counterpart was written: the row points at
    // an account and is linked to nothing.
    const lines = await createTransaction({
      account: 'Checking',
      amount: -29,
      payee: 'Shop',
      notes: 'to-other',
      date: '2026-10-12',
    } as never);
    const text = lines.join('\n');

    expect(text).toContain('Payee:    Other (set by one of your rules, asked for Shop)');
    expect(text).toContain('nothing was created there and the row is not linked to anything');
    expect((await rowsIn(otherId)).map((r) => r.amount)).not.toContain(2900);
  });

  it('does not announce a category Actual is about to take off a transfer', async () => {
    // Both accounts are off budget, which is what `clearCategory` goes by:
    // the two sides on the same side of the budget. It clears both rows, and
    // it does it after the row can first be read, so a reply built from that
    // read announced `Category: Fun` and the budget dropped it seconds later.
    // Forcing it back only triggered the clear again.
    const { result: lines, updates } = await countingUpdates(() =>
      createTransaction({
        account: 'Cash',
        amount: -30,
        payee: 'Savings',
        category: 'Fun',
        date: '2026-10-12',
      } as never),
    );
    const text = lines.join('\n');

    // No category line at all, rather than one saying it is there or one
    // saying it is not: the paragraph below says it once, and a line built
    // from the read is a coin toss while the engine is still working.
    expect(text).not.toMatch(/^ *Category:/m);
    expect(text).toContain('The category was not kept');
    // And nothing was written to put it back. Forcing it only triggers the
    // clear again, which is what made the first version of this contradict
    // the budget two seconds later.
    expect(updates, 'nothing to force when Actual is going to clear it').toBe(0);

    // And the budget, once the engine has finished with it. Read in a loop
    // rather than once: reading it straight away is what made the first
    // version of this agree with a reply that was wrong.
    let category: string | null | undefined = 'not read yet';
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const row = (await rowsIn(cashId)).find((r) => r.amount === -3000) as
        | { category?: string | null }
        | undefined;
      category = row?.category ?? null;
      if (category === null) break;
      await new Promise((resume) => setTimeout(resume, 100));
    }
    expect(category, 'Actual takes it off both rows of this transfer').toBeNull();
  });

  it('announces the transfer when a rule splits it', async () => {
    // `addTransfer` returns early on a split parent, so the part becomes the
    // transfer. Reading the parent said the row was linked to nothing and
    // that no row had been created in the other account, while the matching
    // row was sitting there.
    const lines = await createTransaction({
      account: 'Checking',
      amount: -50,
      payee: 'Savings',
      notes: 'split-xfer',
      date: '2026-10-12',
    } as never);
    const text = lines.join('\n');

    expect(text).toContain('Transfer created:');
    // Described as the movement it is, from the part that made it.
    expect(text).toContain('part  Checking -> Savings  50.00  left your budget');
    expect(text).not.toContain('nothing was created in Savings');
    expect((await rowsIn(savingsId)).map((r) => r.amount)).toContain(5000);
  });

  it('says which payee came from a rule when the parts disagree', async () => {
    // Naming all of them as a rule's doing takes credit away from the one the
    // caller asked for, which is usually among them.
    const lines = await createTransaction({
      account: 'Checking',
      amount: -36,
      payee: 'Shop',
      notes: 'split-two-payees',
      date: '2026-10-12',
    } as never);
    const text = lines.join('\n');

    expect(text).toMatch(/Payee: +.*Theatre/);
    expect(text).toContain('Theatre set by a rule, you asked for Shop');
  });

  it('says when a rule leaves a part of a split pointing at an account', async () => {
    // The dangling payee used to be looked for on the parent only, and a
    // split parent never carries one.
    const lines = await createTransaction({
      account: 'Checking',
      amount: -37,
      payee: 'Shop',
      notes: 'split-to-other',
      date: '2026-10-12',
    } as never);
    const text = lines.join('\n');

    expect(text).toContain('nothing was created there and the row is not linked to anything');
    expect((await rowsIn(otherId)).map((r) => r.amount)).not.toContain(3700);
  });

  it('names the category rather than echoing the id it was given', async () => {
    // Given by id, the sentence about where it counts printed the uuid back.
    // This is the one transfer where a category survives: the two accounts
    // are on opposite sides of the budget, and Actual only clears it when
    // they are on the same one.
    const fun = (await api.getCategories()).find((c) => c.name === 'Fun')!.id;
    const lines = await createTransaction({
      account: 'Checking',
      amount: -38,
      payee: 'Savings',
      category: fun,
      date: '2026-10-12',
    } as never);
    const text = lines.join('\n');

    expect(text).toContain('It counts in Checking, under Fun.');
    expect(text, 'the id is what nobody can read').not.toContain(fun);
  });

  it('describes every movement when a rule splits a transfer two ways', async () => {
    // One transaction, two destinations, and they land on opposite sides of
    // the budget. The reply named one account and called the whole amount a
    // departure from the budget.
    const lines = await createTransaction({
      account: 'Checking',
      amount: -52,
      payee: 'Savings',
      notes: 'split-two-ways',
      date: '2026-10-12',
    } as never);
    const text = lines.join('\n');

    expect(text).toContain('part 1  Checking -> Savings  26.00  left your budget');
    expect(text).toContain('part 2  Checking -> Other    26.00  inside your budget');
    expect(text, 'the whole amount did not leave the budget').not.toContain('52.00  left');
    expect(text, 'there is no single destination to name').not.toMatch(/Transfer to:/);
    expect((await rowsIn(savingsId)).map((r) => r.amount)).toContain(2600);
    expect((await rowsIn(otherId)).map((r) => r.amount)).toContain(2600);
  });

  it('does not file a split part under a category Actual is about to clear', async () => {
    // The part is a transfer between two accounts on the same side of the
    // budget, so it loses its category the same way a plain row does, and the
    // read is just as early.
    // Both accounts off budget, so this stays a transfer even with a
    // category: Actual keeps it a transfer whenever money crosses the edge of
    // the budget, and between two off-budget accounts it clears the category.
    const lines = await createTransaction({
      account: 'Cash',
      amount: -55,
      payee: 'Savings',
      category: 'Fun',
      notes: 'split-xfer',
      date: '2026-10-12',
    } as never);

    const text = lines.join('\n');
    expect(text).not.toContain('under Fun');
    // And why, which otherwise has to be inferred from a part simply having
    // no category.
    expect(text).toContain('The category you asked for was not kept');
    expect(text).toContain('two accounts on the same side of your budget');
  });

  it('says the category was not kept when a rule redirects into the budget', async () => {
    // The rule sends it to an on-budget account, so both sides are on the
    // same side and Actual drops the category. The reply said nothing about
    // it and told the caller to give it a category, which they had.
    const lines = await createTransaction({
      account: 'Checking',
      amount: -22,
      payee: 'Savings',
      category: 'Fun',
      notes: 'to-other',
      date: '2026-10-12',
    } as never);
    const text = lines.join('\n');

    expect(text).not.toMatch(/^ *Category:/m);
    expect(text).toContain('The category was not kept');
    expect(text, 'the category was given').not.toContain('give it a category');
  });

  it('describes a batch row a rule split into a transfer', async () => {
    // The batch read the parent's link, found none, and said the row had not
    // been recorded as a transfer while its parts were linked and the counts
    // in the same reply showed the other account growing.
    const before = (await rowsIn(savingsId)).length;
    const lines = await createTransactions({
      transactions: [
        { account: 'Checking', amount: -33, payee: 'Savings', notes: 'split-me', date: '2026-10-21' },
      ],
    } as never);
    const text = lines.join('\n');

    expect(text).not.toContain('not recorded as a transfer');
    expect(text).toContain('row 1  Checking -> Savings  33.00  left your budget');
    expect((await rowsIn(savingsId)).length).toBeGreaterThan(before);
  });

  it('says so when it could not read the transaction back', async () => {
    // Falling back to the request is the right answer when the budget cannot
    // be read. Letting that pass for a reading of the row is not: every line
    // is then what was asked for.
    const real = api.runQuery;
    (api as { runQuery: unknown }).runQuery = async () => {
      throw new Error('database is locked');
    };
    let text = '';
    try {
      const lines = await createTransaction({
        account: 'Checking',
        amount: -33,
        payee: 'Shop',
        date: '2026-10-12',
        allow_duplicate: true,
      } as never);
      text = lines.join('\n');
    } finally {
      (api as { runQuery: unknown }).runQuery = real;
    }

    expect(text).toContain('Transaction created:');
    expect(text).toContain('The budget could not be read back just now');
  });

  it('names the rows a rule changed in a batch, and stays quiet about the rest', async () => {
    const lines = await createTransactions({
      transactions: [
        { account: 'Checking', amount: -20, payee: 'Shop', date: '2026-10-13' },
        { account: 'Checking', amount: -4.4, payee: 'Shop', notes: 'amount-me', date: '2026-10-13' },
      ],
    } as never);
    const text = lines.join('\n');

    expect(text).toContain('Your rules changed 1 of these rows');
    expect(text).toContain('row 2  Amount: -5.50 (asked for -4.40)');
    expect(text, 'the row nothing happened to has nothing to say').not.toContain('row 1  Amount');
  });

  it('says nothing about rules in a batch no rule touched', async () => {
    const lines = await createTransactions({
      transactions: [
        { account: 'Checking', amount: -21, payee: 'Shop', date: '2026-10-14' },
        { account: 'Checking', amount: -22, payee: 'Shop', date: '2026-10-14' },
      ],
    } as never);

    expect(lines.join('\n')).not.toContain('Your rules changed');
  });

  it('does not list a batch transfer a rule stopped as a transfer', async () => {
    const lines = await createTransactions({
      transactions: [
        { account: 'Checking', amount: -23, payee: 'Savings', date: '2026-10-15' },
        { account: 'Checking', amount: -24, payee: 'Savings', notes: 'xfer-me', date: '2026-10-15' },
      ],
    } as never);
    const text = lines.join('\n');

    expect(text).toContain('1 of them named one of your accounts');
    expect(text).toContain('1 of them named one of your accounts but was not recorded as a transfer');
    // The older wording stays on a batch whose rows each moved once and went
    // where they were sent, which is every batch nothing happened to.
    expect(text).toContain('a matching row was created in the other account:');
    expect(text).toContain('row 2');
    // The one that did happen is still described as one.
    expect((await rowsIn(savingsId)).map((r) => r.amount)).toContain(2300);
    expect((await rowsIn(savingsId)).map((r) => r.amount)).not.toContain(2400);
  });

  it('names the account a rule sent a batch transfer to', async () => {
    const lines = await createTransactions({
      transactions: [
        { account: 'Checking', amount: -31, payee: 'Savings', notes: 'to-other', date: '2026-10-17' },
      ],
    } as never);
    const text = lines.join('\n');

    // The table used to take the route from the request, so it named Savings
    // and classified the movement as money leaving the budget. Other is on
    // budget and is where the matching row went.
    expect(text).toContain('Checking -> Other');
    expect(text).toContain('a rule sent it to Other, not Savings');
    expect(text).toContain('inside your budget');
    expect((await rowsIn(otherId)).map((r) => r.amount)).toContain(3100);
  });

  it('names the payee a rule put on the parts of a split row in a batch', async () => {
    // The batch compared the parent, which carries no payee, so a rule that
    // changed it on the parts went unmentioned.
    const lines = await createTransactions({
      transactions: [
        { account: 'Checking', amount: -32, payee: 'Shop', notes: 'split-payee', date: '2026-10-17' },
      ],
    } as never);

    expect(lines.join('\n')).toContain('row 1  Payee: Theatre (asked for Shop)');
  });

  it('does not draw a route for a batch row that did not become a transfer', async () => {
    // An arrow between two accounts says the money went from one to the
    // other, and the point of that table is that it did not.
    const lines = await createTransactions({
      transactions: [
        { account: 'Checking', amount: -34, payee: 'Savings', notes: 'xfer-me', date: '2026-10-18' },
      ],
    } as never);
    const text = lines.join('\n');

    expect(text).toContain('not recorded as a transfer');
    expect(text).toContain('asked for Savings');
    expect(text, 'no arrow for a movement that did not happen').not.toMatch(
      /row 1 {2}Checking -> Savings/,
    );
  });

  it('does not force a category Actual is about to clear, in a batch either', async () => {
    // The same rule as the single tool, and the batch reply already says the
    // category was not kept. Forcing it back buys one more clear.
    const { result: lines, updates } = await countingUpdates(() =>
      createTransactions({
        transactions: [
          { account: 'Cash', amount: -39, payee: 'Savings', category: 'Fun', date: '2026-10-20' },
        ],
      } as never),
    );

    expect(lines.join('\n')).toContain('not kept');
    expect(updates, 'nothing to force when Actual is going to clear it').toBe(0);
  });

  it('reads the side from the account a batch row reached, not the one asked for', async () => {
    // The rule sends it to an on-budget account, so both sides end up on the
    // same side and Actual clears the category. Going by the accounts that
    // were asked for, Checking and Savings are on opposite sides, so the
    // skip missed and the batch wrote an update that bought one more clear.
    const { result: lines, updates } = await countingUpdates(() =>
      createTransactions({
        transactions: [
          {
            account: 'Checking',
            amount: -41,
            payee: 'Savings',
            category: 'Fun',
            notes: 'to-other',
            date: '2026-10-22',
          },
        ],
      } as never),
    );

    expect(lines.join('\n')).toContain('was not kept');
    expect(updates, 'nothing to force when Actual is going to clear it').toBe(0);
  });

  it('says so when a batch could not be read back', async () => {
    // Only the read-back is broken, by the one query that asks for it: the
    // checks before the write read through the same function, and breaking
    // those would refuse the batch instead of reaching this.
    const real = api.runQuery;
    (api as { runQuery: unknown }).runQuery = async (query: unknown) => {
      if (JSON.stringify(query).includes('transfer_acct')) {
        throw new Error('database is locked');
      }
      return (real as (q: unknown) => Promise<unknown>)(query);
    };
    let text = '';
    try {
      const lines = await createTransactions({
        transactions: [
          { account: 'Checking', amount: -35, payee: 'Shop', date: '2026-10-19' },
        ],
      } as never);
      text = lines.join('\n');
    } finally {
      (api as { runQuery: unknown }).runQuery = real;
    }

    expect(text).toContain('Created 1 transaction.');
    expect(text).toContain('The budget could not be read back just now');
  });

  it('prints the amount the budget holds in the batch transfer table', async () => {
    const lines = await createTransactions({
      transactions: [
        { account: 'Checking', amount: -4.4, payee: 'Savings', notes: 'amount-me', date: '2026-10-16' },
      ],
    } as never);
    const text = lines.join('\n');

    // The table line itself. Looking for "5.50" anywhere passes on the list
    // of changes below it, which names the same figure and would leave the
    // table free to go on printing the one that was sent.
    expect(text).toContain('row 1  Checking -> Savings  5.50  left your budget');
    expect(text).not.toContain('4.40  left your budget');
  });
});
