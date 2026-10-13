import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

vi.mock('@actual-app/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@actual-app/api')>();
  return { ...actual, sync: vi.fn().mockResolvedValue(undefined) };
});
// `getInternal` reaches the harness engine, because reading the budget
// currency goes through the engine's own preference handler.
vi.mock('../../../connection.js', async () => {
  const harness = await import('./actual-engine.js');
  return {
    ensureConnection: vi.fn().mockResolvedValue(undefined),
    getInternal: () => harness.testInternal(),
  };
});

import { initTestEngine, shutdownTestEngine, createFreshBudget, api } from './actual-engine.js';
import { createRuleFromInput, registerCreateRule } from '../../write/create-rule.js';
import {
  withCurrentCurrency,
  budgetDecimalPlaces,
  refreshBudgetDecimalPlaces,
} from '../../../utils/currency.js';

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

  it('refuses an empty figure instead of saving a zero', async () => {
    // `Number("")` and `Number("   ")` are both 0, and 0 passes every check
    // after that. Measured before the fix: an action `set amount = ""` was
    // saved, and the next import that matched it moved a row of -100 to 0.
    // Quiet data loss, on every future import.
    for (const empty of ['', '   ']) {
      await expect(
        createRuleFromInput({
          condition_field: 'notes',
          condition_op: 'is',
          condition_value: 'empty-amount',
          action_field: 'amount',
          action_value: empty,
        } as never),
        `action with "${empty}"`,
      ).rejects.toThrow(/needs a figure/);

      await expect(
        createRuleFromInput({
          condition_field: 'amount',
          condition_op: 'is',
          condition_value: empty,
          action_field: 'category',
          action_value: 'Fun',
        } as never),
        `condition with "${empty}"`,
      ).rejects.toThrow(/needs a figure/);
    }
  });

  it('refuses the notations nobody means when writing an amount', async () => {
    // `Number` reads "0x10" as 16 and "1e3" as 1000, and past 1e20 an integer
    // is not exact any more. None of those is a figure someone typed meaning
    // money.
    // A missing half counts too: ".5" and "45." are not how anyone writes an
    // amount, and both are numbers to `Number`.
    for (const odd of ['0x10', '1e3', '1e20', '4,550', 'forty', '.5', '45.', '- 45.50']) {
      await expect(
        createRuleFromInput({
          condition_field: 'amount',
          condition_op: 'is',
          condition_value: odd,
          action_field: 'category',
          action_value: 'Fun',
        } as never),
        odd,
      ).rejects.toThrow(/takes a figure/);
    }
  });

  it('refuses a figure too large to stay exact', async () => {
    // A plain decimal, and still not a figure: "100000000000000000000" lands
    // on 1e+22 once converted, past the point where an integer is exact, so
    // nothing stored or compared against it means what it says.
    await expect(
      createRuleFromInput({
        condition_field: 'amount',
        condition_op: 'is',
        condition_value: '100000000000000000000',
        action_field: 'category',
        action_value: 'Fun',
      } as never),
    ).rejects.toThrow(/exact/);
  });

  it('says what a zero would do where it would do it', async () => {
    // An empty value means different things in the two places, and the wrong
    // sentence sends the reader looking for the wrong thing.
    const action = await createRuleFromInput({
      condition_field: 'notes',
      condition_op: 'is',
      condition_value: 'empty-here',
      action_field: 'amount',
      action_value: '',
    } as never).catch((e: Error) => e.message);
    expect(action).toContain('sets every matching transaction to nothing');

    const condition = await createRuleFromInput({
      condition_field: 'amount',
      condition_op: 'is',
      condition_value: '',
      action_field: 'category',
      action_value: 'Fun',
    } as never).catch((e: Error) => e.message);
    expect(condition).toContain('match transactions of exactly zero');
  });

  it('refuses more decimals than the currency has, rather than rounding them', async () => {
    // Rounding saves a figure nobody wrote, and the rounding here is not even
    // symmetric: "45.505" gives 4551 and "-45.505" gives -4550.
    await expect(
      createRuleFromInput({
        condition_field: 'amount',
        condition_op: 'is',
        condition_value: '45.505',
        action_field: 'category',
        action_value: 'Fun',
      } as never),
    ).rejects.toThrow(/decimal/);
  });

  it('refuses an operator the engine does not take on a figure', async () => {
    // Measured, one rule per operator: `is`, `isapprox`, `gt`, `gte`, `lt`
    // and `lte` are accepted on amount, and `isNot` comes back as "Invalid
    // condition operator", which reaches the caller as the bare message this
    // tool exists to replace. It was in this tool's own advice.
    const message = await createRuleFromInput({
      condition_field: 'amount',
      condition_op: 'isNot',
      condition_value: '-45.50',
      action_field: 'category',
      action_value: 'Fun',
    } as never).catch((e: Error) => e.message);

    expect(message).toContain('isNot');
    expect(message, 'it has to name the ones that do work').toContain('isapprox');
    expect(message).not.toContain('Failed creating a new rule');
    // The way out of `isNot` is to match what you do want, and that advice
    // belongs to `isNot` alone.
    expect(message).toContain('match the amounts you do want');
  });

  it('does not give the isNot advice for an operator it does not answer', async () => {
    // `contains` on a figure is refused for a different reason entirely, and
    // "match the amounts you do want instead" reads as a non sequitur there.
    const message = await createRuleFromInput({
      condition_field: 'amount',
      condition_op: 'contains',
      condition_value: '-45.50',
      action_field: 'category',
      action_value: 'Fun',
    } as never).catch((e: Error) => e.message);

    expect(message).toContain('contains');
    expect(message).toContain('isapprox');
    expect(message).not.toContain('match the amounts you do want');
  });

  it('names the figure operators when a list is tried on an amount', async () => {
    // The list refusal used to send everyone to `is` or `isNot`, and `isNot`
    // is one of the ones that does not work here.
    const message = await createRuleFromInput({
      condition_field: 'amount',
      condition_op: 'oneOf',
      condition_value: ['-45.50', '-10.00'],
      action_field: 'category',
      action_value: 'Fun',
    } as never).catch((e: Error) => e.message);

    expect(message).toContain('gte');
    expect(message).not.toContain('isNot');
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

  it('stores a rule amount in the budget currency, not in hundredths', async () => {
    // A rule's amount goes through the same conversion as every other amount,
    // so in a budget with no decimal places 100 is a hundred whole units and
    // the rule has to hold 100, not 10,000 (#141, #183).
    //
    // Through the registered tool, because re-reading the currency is wrapped
    // at registration: create_rule is a write, and a write converts at the top
    // of its handler.
    await api.setPreference('defaultCurrencyCode', 'JPY');

    let handler: ((input: unknown) => Promise<unknown>) | undefined;
    registerCreateRule(
      withCurrentCurrency({
        tool: (...a: unknown[]) => {
          handler = a.at(-1) as (input: unknown) => Promise<unknown>;
        },
      }) as never,
    );
    await handler!({
      condition_field: 'amount',
      condition_op: 'is',
      condition_value: '100',
      action_field: 'category',
      action_value: 'Fun',
      stage: 'null',
    });

    expect(budgetDecimalPlaces(), 'the write did not re-read the currency').toBe(0);
    expect(await storedConditions()).toContainEqual(
      expect.objectContaining({ field: 'amount', op: 'is', value: 100 }),
    );

    await api.setPreference('defaultCurrencyCode', 'USD');
    await refreshBudgetDecimalPlaces();
  });
});
