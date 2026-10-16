import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

vi.mock('@actual-app/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@actual-app/api')>();
  return { ...actual, sync: vi.fn().mockResolvedValue(undefined) };
});
vi.mock('../../../connection.js', () => ({
  ensureConnection: vi.fn().mockResolvedValue(undefined),
}));

import {
  initTestEngine,
  shutdownTestEngine,
  createFreshBudget,
  api,
  testInternal,
} from './actual-engine.js';
import { registerGetRules } from '../../read/get-rules.js';
import { deleteRuleGuarded } from '../../write/delete-rule.js';

const skip = process.env.SKIP_ACTUAL_INTEGRATION === '1';

type Handler = () => Promise<{ content: Array<{ type: string; text: string }> }>;

function listing(): Handler {
  let handler: Handler | undefined;
  registerGetRules({
    tool: (...a: unknown[]) => {
      handler = a.at(-1) as Handler;
    },
  } as never);
  return handler as Handler;
}

/**
 * What `delete_rule` shows before it deletes anything (#186).
 *
 * It printed the rule through `JSON.stringify`, so the values came out as the
 * engine stores them: an amount a hundred times larger than the figure it
 * means, a recurrence as its stored config, and a payee as a uuid. The one
 * reply someone says yes to before a rule is gone was the part that could not
 * be read, while `get_rules` had been translating all three since 0.10.5.
 *
 * Written against rules the engine itself wrote for a schedule, because all
 * three shapes are the engine's.
 */
describe.skipIf(skip)('what delete_rule shows before deleting', () => {
  let accountId = '';
  let payeeId = '';
  let categoryId = '';
  let markedRuleId = '';
  let scheduleRuleId = '';

  beforeAll(async () => {
    await initTestEngine();
    await createFreshBudget(async () => {
      accountId = (await api.createAccount(
        { name: 'Checking', offbudget: false } as never,
        0,
      )) as string;
      payeeId = (await api.createPayee({ name: 'Landlord' } as never)) as string;
      const group = await api.createCategoryGroup({ name: 'Spending' } as never);
      categoryId = (await api.createCategory({ name: 'Housing', group_id: group } as never)) as string;
    }, 'delete-rule-readable');

    await testInternal().send('schedule/create' as never, {
      schedule: { name: 'Rent', posts_transaction: false },
      conditions: [
        { op: 'is', field: 'account', value: accountId },
        { op: 'is', field: 'payee', value: payeeId },
        {
          op: 'isapprox',
          field: 'date',
          value: {
            start: '2026-11-01',
            frequency: 'monthly',
            patterns: [],
            skipWeekend: false,
            weekendSolveMode: 'after',
            endMode: 'never',
            endOccurrences: 1,
            endDate: '2026-11-01',
          },
        },
        { op: 'is', field: 'amount', value: -450000 },
      ],
    } as never);

    // The rule Actual wrote for that schedule, caught before anything else
    // is created, since the order rules come back in is not this test's to
    // assume.
    scheduleRuleId = (await api.getRules())[0].id;

    // One rule carrying warnings as well as values, for the comparison
    // below: a rule with nothing wrong with it would not test that the
    // warnings travel with the lines.
    markedRuleId = (
      (await api.createRule({
        stage: null,
        conditionsOp: 'and',
        conditions: [
          { op: 'contains', field: 'payee', value: 'Land' },
          { op: 'is', field: 'amount', value: -450000 },
        ],
        actions: [
          { op: 'set', field: 'cleared', value: 'false' },
          { op: 'set', field: 'notes', value: 'seen' },
        ],
      } as never)) as unknown as { id: string }
    ).id;
  }, 60_000);

  afterAll(async () => {
    await shutdownTestEngine();
  });

  async function previewOf(ruleId: string): Promise<string> {
    const result = await deleteRuleGuarded({ rule_id: ruleId });
    expect(result.deleted, 'the preview must not delete anything').toBe(false);
    return result.lines.join('\n');
  }

  it('reads the rule back the way get_rules does, line for line', async () => {
    // The strongest form this can take: the same lines, in the same order,
    // from the same code. Two tools describing one rule in two ways is what
    // #185 found, where the listing said `false` and the confirmation said
    // `"false"` about one stored value, and the one that looked right was
    // wrong.
    //
    // Compared as a block rather than line by line with `toContain`: that
    // version asked only whether each line appeared somewhere, so it passed
    // with the order shuffled, with a warning missing and with the
    // indentation changed, which is most of what could go wrong.
    const listed = (await listing()()).content[0].text.split('\n');
    const from = listed.indexOf(`Rule: ${markedRuleId}`);
    expect(from, 'the rule has to be in the listing to compare against').toBeGreaterThanOrEqual(0);
    // Everything under its header until the blank line that ends the rule.
    const body = listed.slice(from + 2, listed.indexOf('', from + 2));
    expect(body.length, 'the schedule rule has lines to compare').toBeGreaterThan(3);
    expect(
      body.some((line) => line.includes('warning:')),
      'a rule with no warning would not test that they travel with the lines',
    ).toBe(true);

    const preview = await previewOf(markedRuleId);
    // Two spaces deeper, and nothing else different.
    expect(preview).toContain(body.map((line) => `  ${line}`).join('\n'));
  });

  it('shows the amount as money, not as the integer the engine stores', async () => {
    const preview = await previewOf(scheduleRuleId);

    expect(preview).toContain('-4,500.00');
    expect(preview, 'the stored integer is the figure times a hundred').not.toContain('-450000');
  });

  it('says when the schedule runs, instead of printing its stored config', async () => {
    const preview = await previewOf(scheduleRuleId);

    expect(preview).toContain('every month, from 2026-11-01');
    expect(preview).not.toContain('weekendSolveMode');
    expect(preview).not.toContain('[object Object]');
  });

  it('names the payee and the account instead of their ids', async () => {
    const preview = await previewOf(scheduleRuleId);

    expect(preview).toContain('IF payee is Landlord');
    expect(preview).toContain('IF account is Checking');
    expect(preview).not.toContain(payeeId);
    expect(preview).not.toContain(accountId);
  });

  it('marks a rule that would take every import down with it', async () => {
    // The warnings travel with the lines, and this is where they are worth
    // most: the question the preview answers is whether to delete this rule,
    // and a rule that stops a bank sync answers it.
    const id = (await api.createRule({
      stage: null,
      conditionsOp: 'and',
      conditions: [{ op: 'is', field: 'notes', value: 'poison' }],
      actions: [{ op: 'set', field: 'transfer', value: true }],
    } as never)) as unknown as { id: string };

    const preview = await previewOf(id.id);

    expect(preview).toContain('Actual keeps no transfer column');
  });

  it('still deletes when confirmed', async () => {
    const id = (await api.createRule({
      stage: null,
      conditionsOp: 'and',
      conditions: [{ op: 'is', field: 'payee', value: payeeId }],
      actions: [{ op: 'set', field: 'category', value: categoryId }],
    } as never)) as unknown as { id: string };

    const result = await deleteRuleGuarded({ rule_id: id.id, confirm: true });

    expect(result.deleted).toBe(true);
    expect((await api.getRules()).map((r) => r.id)).not.toContain(id.id);
  });
});
