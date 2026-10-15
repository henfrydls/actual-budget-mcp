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
 * be read, while `get_rules` had been translating all three since 0.10.4.
 *
 * Written against rules the engine itself wrote for a schedule, because all
 * three shapes are the engine's.
 */
describe.skipIf(skip)('what delete_rule shows before deleting', () => {
  let accountId = '';
  let payeeId = '';
  let categoryId = '';

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
    // The strongest form this can take: the same lines, from the same code.
    // Two tools describing one rule in two ways is what #185 found, where the
    // listing said `false` and the confirmation said `"false"` about one
    // stored value, and the one that looked right was wrong.
    const rule = (await api.getRules())[0];
    const text = await listing()();
    const listed = text.content[0].text
      .split('\n')
      .filter((line) => line.startsWith('  IF ') || line.startsWith('  THEN '));
    expect(listed.length, 'the schedule rule has conditions to compare').toBeGreaterThan(0);

    const preview = await previewOf(rule.id);
    for (const line of listed) {
      expect(preview).toContain(line.trim());
    }
  });

  it('shows the amount as money, not as the integer the engine stores', async () => {
    const rule = (await api.getRules())[0];
    const preview = await previewOf(rule.id);

    expect(preview).toContain('-4,500.00');
    expect(preview, 'the stored integer is the figure times a hundred').not.toContain('-450000');
  });

  it('says when the schedule runs, instead of printing its stored config', async () => {
    const rule = (await api.getRules())[0];
    const preview = await previewOf(rule.id);

    expect(preview).toContain('every month, from 2026-11-01');
    expect(preview).not.toContain('weekendSolveMode');
    expect(preview).not.toContain('[object Object]');
  });

  it('names the payee and the account instead of their ids', async () => {
    const rule = (await api.getRules())[0];
    const preview = await previewOf(rule.id);

    expect(preview).toContain('"Landlord"');
    expect(preview).toContain('"Checking"');
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
