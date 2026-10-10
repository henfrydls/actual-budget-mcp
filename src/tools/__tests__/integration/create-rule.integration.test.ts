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
 * `create_rule` with a payee, against the real engine.
 *
 * Actual types `payee` as an id field. The tool passed the name through as
 * given, so the rule was stored, reported as created, and never matched. These
 * check what the engine stored and what it did with an imported row, not the
 * reply text, which read as success either way.
 */
describe.skipIf(skip)('create_rule with a payee', () => {
  let accountId = '';
  let payeeId = '';
  let primeId = '';
  let groceriesId = '';

  beforeAll(async () => {
    await initTestEngine();
    await createFreshBudget(async () => {
      accountId = await api.createAccount({ name: 'Checking', offbudget: false } as never, 0);
      payeeId = await api.createPayee({ name: 'Amazon' } as never);
      primeId = await api.createPayee({ name: 'Amazon Prime' } as never);
      const groupId = await api.createCategoryGroup({ name: 'Spending' } as never);
      groceriesId = await api.createCategory({ name: 'Groceries', group_id: groupId } as never);
    }, 'create-rule');
  });

  afterAll(async () => {
    await shutdownTestEngine();
  });

  async function storedRule(id: string) {
    const rules = await api.getRules();
    return rules.find((r) => r.id === id) as
      | { conditions: Array<{ value: unknown }>; actions: Array<{ value: unknown }> }
      | undefined;
  }

  function idFrom(lines: string[]): string {
    return lines.find((l) => l.includes('ID:'))!.split('ID:')[1].trim();
  }

  it('stores a payee condition as the payee id, not its name', async () => {
    const lines = await createRuleFromInput({
      condition_field: 'payee',
      condition_op: 'is',
      condition_value: 'Amazon',
      action_field: 'category',
      action_value: 'Groceries',
    });
    const rule = await storedRule(idFrom(lines));
    expect(rule?.conditions[0].value).toBe(payeeId);
  });

  it('applies a payee rule to an imported transaction from that payee', async () => {
    await createRuleFromInput({
      condition_field: 'payee',
      condition_op: 'is',
      condition_value: 'Amazon',
      action_field: 'category',
      action_value: 'Groceries',
    });
    await api.importTransactions(accountId, [
      { date: '2026-09-10', amount: -2500, payee_name: 'Amazon' },
    ] as never);
    const txns = await api.getTransactions(accountId, '2026-09-10', '2026-09-10');
    expect(txns[0]?.category).toBe(groceriesId);
  });

  it('accepts a payee id as well as a name', async () => {
    const lines = await createRuleFromInput({
      condition_field: 'payee',
      condition_op: 'is',
      condition_value: primeId,
      action_field: 'category',
      action_value: 'Groceries',
    });
    const rule = await storedRule(idFrom(lines));
    expect(rule?.conditions[0].value).toBe(primeId);
  });

  it('prefers an exact name, so "amazon" picks "Amazon" over "Amazon Prime"', async () => {
    const lines = await createRuleFromInput({
      condition_field: 'payee',
      condition_op: 'is',
      condition_value: 'amazon',
      action_field: 'category',
      action_value: 'Groceries',
    });
    const rule = await storedRule(idFrom(lines));
    expect(rule?.conditions[0].value).toBe(payeeId);
  });

  it('accepts part of a name when only one payee matches it', async () => {
    const lines = await createRuleFromInput({
      condition_field: 'payee',
      condition_op: 'is',
      condition_value: 'Prime',
      action_field: 'category',
      action_value: 'Groceries',
    });
    const rule = await storedRule(idFrom(lines));
    expect(rule?.conditions[0].value).toBe(primeId);
  });

  it('refuses part of a name that matches more than one payee, and stores nothing', async () => {
    const before = (await api.getRules()).length;
    await expect(
      createRuleFromInput({
        condition_field: 'payee',
        condition_op: 'is',
        condition_value: 'Amaz',
        action_field: 'category',
        action_value: 'Groceries',
      }),
    ).rejects.toThrow(/Ambiguous payee name "Amaz"/);
    expect((await api.getRules()).length).toBe(before);
  });

  it('refuses a condition on a payee that does not exist, and stores nothing', async () => {
    const before = (await api.getRules()).length;
    await expect(
      createRuleFromInput({
        condition_field: 'payee',
        condition_op: 'is',
        condition_value: 'Netflix',
        action_field: 'category',
        action_value: 'Groceries',
      }),
    ).rejects.toThrow(/No payee found matching "Netflix"/);
    expect((await api.getRules()).length).toBe(before);
  });

  it('does not take an account name for a payee in a condition', async () => {
    // Every account has a hidden payee with the account's name, used for
    // transfers. A rule on it by name would match every transfer into the
    // account.
    await expect(
      createRuleFromInput({
        condition_field: 'payee',
        condition_op: 'is',
        condition_value: 'Checking',
        action_field: 'category',
        action_value: 'Groceries',
      }),
    ).rejects.toThrow(/No payee found matching "Checking"/);
  });

  it('leaves a payee "contains" value as text, since it is not a payee', async () => {
    const lines = await createRuleFromInput({
      condition_field: 'payee',
      condition_op: 'contains',
      condition_value: 'Amaz',
      action_field: 'category',
      action_value: 'Groceries',
    });
    const rule = await storedRule(idFrom(lines));
    expect(rule?.conditions[0].value).toBe('Amaz');
  });

  it('stores a payee action as the payee id, not its name', async () => {
    const lines = await createRuleFromInput({
      condition_field: 'notes',
      condition_op: 'contains',
      condition_value: 'AMZN',
      action_field: 'payee',
      action_value: 'Amazon',
    });
    const rule = await storedRule(idFrom(lines));
    expect(rule?.actions[0].value).toBe(payeeId);
  });

  it('creates the payee a rule action names when there is none', async () => {
    const lines = await createRuleFromInput({
      condition_field: 'notes',
      condition_op: 'contains',
      condition_value: 'NFLX',
      action_field: 'payee',
      action_value: 'Netflix',
    });
    const rule = await storedRule(idFrom(lines));
    const created = (await api.getPayees()).find((p) => p.name === 'Netflix');
    expect(created).toBeDefined();
    expect(rule?.actions[0].value).toBe(created!.id);
  });
});
