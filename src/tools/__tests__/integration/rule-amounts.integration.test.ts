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
 * A rule about an amount (#183).
 *
 * Actual keeps an amount as an integer in the currency's smallest unit, and
 * this tool passed through whatever string it was given. Measured against the
 * engine, that failed in two different ways and neither of them said so:
 *
 *   condition `amount is "-45.50"`   refused: "Value must be a number or
 *                                    between", which reached the caller as a
 *                                    bare "Failed creating a new rule". No
 *                                    rule about an amount could be made here.
 *
 *   action `set amount = "-45.50"`   saved without complaint, and then the
 *                                    next import that matched it died on
 *                                    `Can't convert to integer: "-45.50"`.
 *
 * So the check is that the rule is created, that the engine holds the integer,
 * and that a transaction actually gets it. The last one is the part that
 * proves the rule runs, which is what was missing before.
 */
describe.skipIf(skip)('rules about an amount (#183)', () => {
  let accountId = '';
  let categoryId = '';

  beforeAll(async () => {
    await initTestEngine();
    await createFreshBudget(async () => {
      accountId = (await api.createAccount({ name: 'Checking', offbudget: false } as never, 0)) as string;
      const group = await api.createCategoryGroup({ name: 'Spending' } as never);
      categoryId = (await api.createCategory({ name: 'Fun', group_id: group } as never)) as string;
    }, 'rule-amounts');
  }, 60_000);

  afterAll(async () => {
    await shutdownTestEngine();
  });

  /** The conditions of every rule in the budget. */
  async function storedConditions(): Promise<unknown[]> {
    const rules = (await api.getRules()) as { conditions?: unknown[] }[];
    return rules.flatMap((rule) => rule.conditions ?? []);
  }

  it('stores the figure as the engine stores amounts', async () => {
    await createRuleFromInput({
      condition_field: 'amount',
      condition_op: 'is',
      condition_value: '-45.50',
      action_field: 'category',
      action_value: 'Fun',
    } as never);

    expect(await storedConditions()).toContainEqual(
      expect.objectContaining({ field: 'amount', op: 'is', value: -4550 }),
    );
  });

  it('categorises a transaction of that amount, which is the point', async () => {
    // The end-to-end check. Before this, the rule did not exist to run.
    await api.importTransactions(accountId, [
      { date: '2026-10-12', amount: -4550, payee_name: 'Cinema', imported_id: 'amt-1' } as never,
    ]);

    let rows: { amount: number; category?: string | null }[] = [];
    for (let attempt = 0; attempt < 8; attempt += 1) {
      rows = (await api.getTransactions(accountId, '2000-01-01', '2100-01-01')) as never;
      if (rows.length > 0) break;
    }

    const row = rows.find((r) => r.amount === -4550);
    expect(row, 'the transaction was not imported').toBeDefined();
    expect(row!.category, 'the rule did not fire').toBe(categoryId);
  });

  it('says what it understood, in both directions', async () => {
    const lines = await createRuleFromInput({
      condition_field: 'amount',
      condition_op: 'gte',
      condition_value: '1200',
      action_field: 'category',
      action_value: 'Fun',
    } as never);
    const text = lines.join('\n');

    // 1200 is twelve hundred, not twelve: the reading is what was wrong, so
    // it is said back with the integer beside it.
    expect(text).toContain('1,200.00');
    expect(text).toContain('120000');
  });

  it('refuses a value that is not an amount, instead of the engine refusing it', async () => {
    // The engine's own answer for this is "Failed creating a new rule", which
    // names neither the field nor the reason.
    await expect(
      createRuleFromInput({
        condition_field: 'amount',
        condition_op: 'is',
        condition_value: 'about fifty',
        action_field: 'category',
        action_value: 'Fun',
      } as never),
    ).rejects.toThrow(/amount/i);
  });

  it('converts it in an action too, where a bad value broke the next import', async () => {
    await createRuleFromInput({
      condition_field: 'notes',
      condition_op: 'is',
      condition_value: 'set-the-amount',
      action_field: 'amount',
      action_value: '-45.50',
    } as never);

    const rules = (await api.getRules()) as { actions?: { field?: string; value?: unknown }[] }[];
    const actions = rules.flatMap((rule) => rule.actions ?? []);
    expect(actions).toContainEqual(expect.objectContaining({ field: 'amount', value: -4550 }));

    // And the import that would have died on a string goes through.
    await api.importTransactions(accountId, [
      {
        date: '2026-10-13',
        amount: -100,
        notes: 'set-the-amount',
        payee_name: 'Shop',
        imported_id: 'amt-2',
      } as never,
    ]);

    let rows: { amount: number; notes?: string | null }[] = [];
    for (let attempt = 0; attempt < 8; attempt += 1) {
      rows = (await api.getTransactions(accountId, '2000-01-01', '2100-01-01')) as never;
      if (rows.some((r) => r.notes === 'set-the-amount')) break;
    }
    expect(rows.find((r) => r.notes === 'set-the-amount')?.amount).toBe(-4550);
  });
});
