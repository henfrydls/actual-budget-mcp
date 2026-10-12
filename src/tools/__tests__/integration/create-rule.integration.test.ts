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

  it('matches a name in any case, so "amazon" is "Amazon"', async () => {
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

  it('refuses part of a name even when only one payee contains it', async () => {
    // A rule is stored and keeps running, so "Prime" quietly saved as "Amazon
    // Prime" recategorises transactions for months under a reply that said
    // "Prime". The suggestion is there because the payee probably is the one
    // they meant; what they have to do is name it.
    const before = (await api.getRules()).length;
    await expect(
      createRuleFromInput({
        condition_field: 'payee',
        condition_op: 'is',
        condition_value: 'Prime',
        action_field: 'category',
        action_value: 'Groceries',
      }),
    ).rejects.toThrow(/No payee found matching "Prime"[\s\S]*Did you mean: Amazon Prime\?/);
    expect((await api.getRules()).length).toBe(before);
  });

  it('lists every near miss, so the one that was meant is in the reply', async () => {
    const before = (await api.getRules()).length;
    await expect(
      createRuleFromInput({
        condition_field: 'payee',
        condition_op: 'is',
        condition_value: 'Amaz',
        action_field: 'category',
        action_value: 'Groceries',
      }),
    ).rejects.toThrow(/Did you mean: Amazon, Amazon Prime\?/);
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

  it('says which payee the rule holds, since the name was typed and the id is stored', async () => {
    // A name that matched one they did not have in mind is invisible
    // otherwise: the rule holds an id, and the reply quoted what they typed.
    const lines = await createRuleFromInput({
      condition_field: 'payee',
      condition_op: 'is',
      condition_value: 'amazon',
      action_field: 'payee',
      action_value: 'Amazon Prime',
    });
    const text = lines.join('\n');

    expect(text).toContain(`Condition payee: Amazon (${payeeId})`);
    expect(text).toContain(`Action payee: Amazon Prime (${primeId})`);
  });

  it('says nothing about a payee when the rule has none', async () => {
    const lines = await createRuleFromInput({
      condition_field: 'notes',
      condition_op: 'contains',
      condition_value: 'AMZN',
      action_field: 'category',
      action_value: 'Groceries',
    });

    expect(lines.join('\n')).not.toMatch(/payee/i);
  });

  it('refuses two payees with the same name rather than picking one', async () => {
    // Measured: the engine accepts a second payee with the same name, and
    // both come back from getPayees. Choosing either would be choosing at
    // random, and the rule would keep running on it.
    const twinId = await api.createPayee({ name: 'Netflix' } as never);
    await api.createPayee({ name: 'Netflix' } as never);
    const before = (await api.getRules()).length;

    await expect(
      createRuleFromInput({
        condition_field: 'payee',
        condition_op: 'is',
        condition_value: 'Netflix',
        action_field: 'category',
        action_value: 'Groceries',
      }),
    ).rejects.toThrow(/Ambiguous payee name "Netflix"/);
    expect((await api.getRules()).length).toBe(before);

    // And the id still works, which is the way out the message points at.
    const lines = await createRuleFromInput({
      condition_field: 'payee',
      condition_op: 'is',
      condition_value: twinId,
      action_field: 'category',
      action_value: 'Groceries',
    });
    expect((await storedRule(idFrom(lines)))?.conditions[0].value).toBe(twinId);
  });

  it('refuses an action on a payee that does not exist, and saves no rule and no payee', async () => {
    // Creating it would turn a typo like "Amazn" into a new payee that the
    // rule then moves transactions to, with nothing reporting it.
    const rulesBefore = (await api.getRules()).length;
    const payeesBefore = (await api.getPayees()).length;
    await expect(
      createRuleFromInput({
        condition_field: 'notes',
        condition_op: 'contains',
        condition_value: 'AMZN',
        action_field: 'payee',
        action_value: 'Amazn',
      }),
    ).rejects.toThrow(/No payee found matching "Amazn"/);
    expect((await api.getRules()).length).toBe(rulesBefore);
    expect((await api.getPayees()).length).toBe(payeesBefore);
  });
});
