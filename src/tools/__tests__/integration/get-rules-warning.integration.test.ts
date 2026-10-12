import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

vi.mock('@actual-app/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@actual-app/api')>();
  return { ...actual, sync: vi.fn().mockResolvedValue(undefined) };
});
vi.mock('../../../connection.js', () => ({
  ensureConnection: vi.fn().mockResolvedValue(undefined),
}));

import { initTestEngine, shutdownTestEngine, createFreshBudget, api } from './actual-engine.js';
import { registerGetRules } from '../../read/get-rules.js';

const skip = process.env.SKIP_ACTUAL_INTEGRATION === '1';

type Handler = () => Promise<{ content: Array<{ type: string; text: string }> }>;

function handlerFor(): Handler {
  let handler: Handler | undefined;
  registerGetRules({
    tool: (...a: unknown[]) => {
      handler = a.at(-1) as Handler;
    },
  } as never);
  return handler as Handler;
}

/**
 * Finding the rules that were created before #169 was refused.
 *
 * They are still in the budget and still firing, and nothing in a listing
 * shows what is wrong: the condition reads like any other. `create_rule`
 * refusing new ones does nothing for the ones already there, and the only way
 * to find them by hand is to know about the id comparison and read every rule.
 */
describe.skipIf(skip)('listing rules that compare text against an id', () => {
  let payee = '';

  beforeAll(async () => {
    await initTestEngine();
    await createFreshBudget(async () => {
      await api.createAccount({ name: 'Checking', offbudget: false } as never, 0);
      payee = await api.createPayee({ name: 'Netflix' } as never);
      const group = await api.createCategoryGroup({ name: 'Spending' } as never);
      await api.createCategory({ name: 'Fun', group_id: group } as never);
    }, 'get-rules-warning');
  }, 60_000);

  afterAll(async () => {
    await shutdownTestEngine();
  });

  it('marks one, says why, and says what to use instead', async () => {
    // Created through the engine, which is how they got there: `create_rule`
    // will not make one any more.
    await api.createRule({
      stage: null,
      conditionsOp: 'and',
      conditions: [{ field: 'payee', op: 'contains', value: 'Netfl' }],
      actions: [{ op: 'set', field: 'notes', value: 'marked' }],
    } as never);

    const text = (await handlerFor()()).content[0].text;

    expect(text).toContain('IF payee contains "Netfl"');
    expect(text).toMatch(/warning: .*compares against the internal id/);
    expect(text).toMatch(/imported_payee/);
    expect(text).toMatch(/1 condition above compares/);
  }, 60_000);

  it('counts every one of them, across fields and operators', async () => {
    await api.createRule({
      stage: null,
      conditionsOp: 'and',
      conditions: [{ field: 'category', op: 'doesNotContain', value: 'Fun' }],
      actions: [{ op: 'set', field: 'notes', value: 'marked' }],
    } as never);
    await api.createRule({
      stage: null,
      conditionsOp: 'and',
      conditions: [{ field: 'account', op: 'matches', value: 'Check' }],
      actions: [{ op: 'set', field: 'notes', value: 'marked' }],
    } as never);
    // The fourth id field, which the first version of this missed.
    await api.createRule({
      stage: null,
      conditionsOp: 'and',
      conditions: [{ field: 'category_group', op: 'contains', value: 'Spend' }],
      actions: [{ op: 'set', field: 'notes', value: 'marked' }],
    } as never);

    const text = (await handlerFor()()).content[0].text;

    // The one from the previous case plus these three.
    expect(text).toMatch(/4 conditions above compare/);
    // And each is named where it is, not only in the total.
    expect(text.match(/warning: /g)).toHaveLength(4);
  }, 60_000);

  it('counts every bad condition in one rule, not the rule once', async () => {
    // A rule carries a list of conditions, and the count is about conditions.
    // Counting rules instead reads as fewer problems than there are.
    await createFreshBudget(async () => {
      await api.createAccount({ name: 'Checking', offbudget: false } as never, 0);
      const group = await api.createCategoryGroup({ name: 'Spending' } as never);
      await api.createCategory({ name: 'Fun', group_id: group } as never);
    }, 'get-rules-multi');
    await api.createRule({
      stage: null,
      conditionsOp: 'and',
      conditions: [
        { field: 'payee', op: 'contains', value: 'Netfl' },
        { field: 'category', op: 'matches', value: 'Fun' },
        { field: 'category_group', op: 'doesNotContain', value: 'Spend' },
        { field: 'notes', op: 'contains', value: 'fine' },
        { field: 'amount', op: 'gt', value: 100 },
      ],
      actions: [{ op: 'set', field: 'notes', value: 'marked' }],
    } as never);

    const text = (await handlerFor()()).content[0].text;

    expect(text).toMatch(/3 conditions above compare/);
    expect(text.match(/warning: /g)).toHaveLength(3);
  }, 60_000);

  it('says the rule may look right where it was written', async () => {
    // Actual's own filters compare by name, so a rule that can never fire can
    // still look correct. Hedged on purpose: what was checked is the engine's
    // filter translation, not the editor's screen, and claiming the screen
    // would be stating something nobody measured.
    const text = (await handlerFor()()).content[0].text;
    expect(text).toMatch(/filters compare by name, so the rule may look right/);
  }, 60_000);

  it('says nothing about a rule that is fine', async () => {
    await createFreshBudget(async () => {
      await api.createPayee({ name: 'Netflix' } as never);
      const group = await api.createCategoryGroup({ name: 'Spending' } as never);
      await api.createCategory({ name: 'Fun', group_id: group } as never);
    }, 'get-rules-clean');
    const fresh = (await api.getPayees()).find((p) => p.name === 'Netflix')!.id;
    await api.createRule({
      stage: null,
      conditionsOp: 'and',
      conditions: [{ field: 'payee', op: 'is', value: fresh }],
      actions: [{ op: 'set', field: 'notes', value: 'marked' }],
    } as never);
    await api.createRule({
      stage: null,
      conditionsOp: 'and',
      conditions: [{ field: 'imported_payee', op: 'contains', value: 'NETFL' }],
      actions: [{ op: 'set', field: 'notes', value: 'marked' }],
    } as never);

    const text = (await handlerFor()()).content[0].text;

    expect(text).not.toMatch(/warning/);
    expect(text).not.toMatch(/compare text against an internal id/);
    void payee;
  }, 60_000);
});
