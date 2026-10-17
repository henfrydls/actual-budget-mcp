import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

vi.mock('@actual-app/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@actual-app/api')>();
  return { ...actual, sync: vi.fn().mockResolvedValue(undefined) };
});
vi.mock('../../../connection.js', () => ({
  ensureConnection: vi.fn().mockResolvedValue(undefined),
}));

import { initTestEngine, shutdownTestEngine, createFreshBudget, api } from './actual-engine.js';

const skip = process.env.SKIP_ACTUAL_INTEGRATION === '1';

/**
 * What a rule that sets `account` does, on each of the three ways a
 * transaction reaches a budget.
 *
 * `create_rule` has told people since 0.10.4 that setting an account moves
 * the transaction, and #184 measured that it does not, which looked like a
 * contradiction and is not: the two statements are about different routes.
 * Both texts now name the route, and this holds the engine to each of them.
 *
 * It matters which way round it is. "A rule that sets account does nothing"
 * is the dangerous reading, because such a rule moves rows on every bank
 * sync, and somebody who believes it is inert leaves it there.
 */
describe.skipIf(skip)('a rule that sets the account', () => {
  let checkingId = '';
  let otherId = '';

  beforeAll(async () => {
    await initTestEngine();
    await createFreshBudget(async () => {
      checkingId = (await api.createAccount(
        { name: 'Checking', offbudget: false } as never,
        0,
      )) as string;
      otherId = (await api.createAccount({ name: 'Other', offbudget: false } as never, 0)) as string;
    }, 'rule-sets-account');

    // The second action is what tells a rule that did not fire from an engine
    // that ignored half of it. Without it, both look the same from outside.
    await api.createRule({
      stage: null,
      conditionsOp: 'and',
      conditions: [{ op: 'is', field: 'notes', value: 'move-me' }],
      actions: [
        { op: 'set', field: 'account', value: otherId },
        { op: 'set', field: 'cleared', value: true },
      ],
    } as never);
  }, 60_000);

  afterAll(async () => {
    await shutdownTestEngine();
  });

  /**
   * Where a transaction of this amount is, once the engine has settled.
   *
   * Read in a loop until one account holds it. A move is two writes, and a
   * read taken between them finds the row in both: the first version of this
   * saw `['Checking', 'Other']` and would have called a move that happened a
   * move that did not.
   */
  async function accountOf(amountCents: number): Promise<string[]> {
    let where: string[] = [];
    for (let attempt = 0; attempt < 40; attempt += 1) {
      where = [];
      for (const [id, name] of [
        [checkingId, 'Checking'],
        [otherId, 'Other'],
      ] as const) {
        const rows = (await api.getTransactions(id, '2000-01-01', '2100-01-01')) as Array<{
          amount: number;
        }>;
        if (rows.some((row) => row.amount === amountCents)) where.push(name);
      }
      if (where.length === 1) break;
      await new Promise((resume) => setTimeout(resume, 100));
    }
    return where;
  }

  it('does not move a transaction this server creates', async () => {
    // `addTransactions` builds the row it inserts as `{ id, ...trans, account:
    // acctId }`, so the account argument is written over whatever the rule
    // chose. This is the route `create_transaction` and `create_transactions`
    // use, which is why their replies keep naming the account they were given.
    await api.addTransactions(
      checkingId,
      [{ date: '2026-10-12', amount: -1000, notes: 'move-me', payee_name: 'Shop' }] as never,
      { learnCategories: false, runTransfers: false } as never,
    );

    expect(await accountOf(-1000)).toEqual(['Checking']);
    // And the rule did fire, so this is the engine ignoring one action rather
    // than the rule not matching.
    const rows = (await api.getTransactions(checkingId, '2000-01-01', '2100-01-01')) as Array<{
      amount: number;
      cleared?: boolean;
    }>;
    expect(rows.find((row) => row.amount === -1000)?.cleared).toBe(true);
  }, 60_000);

  it('moves one that arrives through an import or a bank sync', async () => {
    // `reconcileTransactions` inserts what the rules left, with no account
    // written over it. This is the route a file import and a bank sync take,
    // so the warning `create_rule` has carried since 0.10.4 is about this one.
    await api.importTransactions(checkingId, [
      { date: '2026-10-13', amount: -2000, notes: 'move-me', payee_name: 'Shop' },
    ] as never);

    expect(await accountOf(-2000)).toEqual(['Other']);
  }, 60_000);

  it('moves one that is updated, which is how a rule applied by hand lands', async () => {
    await api.addTransactions(
      checkingId,
      [{ date: '2026-10-14', amount: -3000, payee_name: 'Shop' }] as never,
      { learnCategories: false, runTransfers: false } as never,
    );
    const rows = (await api.getTransactions(checkingId, '2000-01-01', '2100-01-01')) as Array<{
      id: string;
      amount: number;
    }>;
    const id = rows.find((row) => row.amount === -3000)!.id;

    await api.updateTransaction(id, { account: otherId } as never);

    expect(await accountOf(-3000)).toEqual(['Other']);
  }, 60_000);
});
