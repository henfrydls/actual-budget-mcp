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
    expect(text).toMatch(/1 line above is marked/);
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
    expect(text).toMatch(/4 lines above are marked/);
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

    expect(text).toMatch(/3 lines above are marked/);
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
    expect(text).not.toMatch(/lines? above (is|are) marked/);
    void payee;
  }, 60_000);

  it('reads a list back as names, not as a row of ids', async () => {
    // `oneOf` holds an array, and printing it raw was a line of UUIDs
    // separated by commas, which nobody can check.
    await createFreshBudget(async () => {
      await api.createAccount({ name: 'Checking', offbudget: false } as never, 0);
      await api.createPayee({ name: 'Netflix' } as never);
      await api.createPayee({ name: 'Spotify' } as never);
      const group = await api.createCategoryGroup({ name: 'Spending' } as never);
      await api.createCategory({ name: 'Fun', group_id: group } as never);
    }, 'get-rules-list');
    const payees = await api.getPayees();
    const ids = ['Netflix', 'Spotify'].map((n) => payees.find((p) => p.name === n)!.id);

    await api.createRule({
      stage: null,
      conditionsOp: 'and',
      conditions: [{ field: 'payee', op: 'oneOf', value: ids }],
      actions: [{ op: 'set', field: 'category', value: (await api.getCategories()).find((c) => c.name === 'Fun')!.id }],
    } as never);

    const text = (await handlerFor()()).content[0].text;

    expect(text).toContain('IF payee oneOf Netflix, Spotify');
    expect(text).toContain('THEN set category = Fun');
    // On the IF and THEN lines only: the rule's own id is on its header line
    // and belongs there, since delete_rule takes it.
    const conditionsAndActions = text
      .split('\n')
      .filter((l) => l.includes('IF ') || l.includes('THEN '));
    expect(conditionsAndActions.join('\n'), 'a uuid reached the reply').not.toMatch(
      /[0-9a-f]{8}-[0-9a-f]{4}-/,
    );
  }, 60_000);

  it('reads an account and a category group back as names', async () => {
    await createFreshBudget(async () => {
      await api.createAccount({ name: 'Checking', offbudget: false } as never, 0);
      const group = await api.createCategoryGroup({ name: 'Spending' } as never);
      await api.createCategory({ name: 'Fun', group_id: group } as never);
    }, 'get-rules-account');
    const acct = (await api.getAccounts()).find((a) => a.name === 'Checking')!.id;
    const group = (await api.getCategoryGroups()).find((g) => g.name === 'Spending')!.id;

    await api.createRule({
      stage: null,
      conditionsOp: 'and',
      conditions: [{ field: 'category_group', op: 'is', value: group }],
      actions: [{ op: 'set', field: 'account', value: acct }],
    } as never);

    const text = (await handlerFor()()).content[0].text;

    expect(text).toContain('IF category_group is Spending');
    expect(text).toContain('THEN set account = Checking');
  }, 60_000);

  it('marks a rule that holds a name where an id belongs', async () => {
    // What the bug behind #167 and #170 left in people's budgets: the
    // condition reads perfectly well and the rule has never matched anything.
    await createFreshBudget(async () => {
      await api.createAccount({ name: 'Checking', offbudget: false } as never, 0);
      const group = await api.createCategoryGroup({ name: 'Spending' } as never);
      await api.createCategory({ name: 'Fun', group_id: group } as never);
    }, 'get-rules-stale-name');

    await api.createRule({
      stage: null,
      conditionsOp: 'and',
      conditions: [{ field: 'account', op: 'is', value: 'Checking' }],
      actions: [{ op: 'set', field: 'notes', value: 'marked' }],
    } as never);

    const text = (await handlerFor()()).content[0].text;

    expect(text).toMatch(/stores "Checking" where Actual expects an account id/);
    expect(text).toMatch(/never fires/);
    expect(text).toMatch(/1 line above is marked/);
  }, 60_000);

  it('tells a deleted thing apart from a name', async () => {
    // An id that resolves to nothing was pointing at something once, so the
    // advice is different: there is no name to resolve.
    await createFreshBudget(async () => {
      await api.createAccount({ name: 'Checking', offbudget: false } as never, 0);
      const group = await api.createCategoryGroup({ name: 'Spending' } as never);
      await api.createCategory({ name: 'Fun', group_id: group } as never);
    }, 'get-rules-deleted');

    await api.createRule({
      stage: null,
      conditionsOp: 'and',
      conditions: [
        { field: 'payee', op: 'is', value: '7f46d9e7-1b2c-4d3e-8f90-a1b2c3d4e5f6' },
      ],
      actions: [{ op: 'set', field: 'notes', value: 'marked' }],
    } as never);

    const text = (await handlerFor()()).content[0].text;

    expect(text).toMatch(/points at an id that is no longer in the budget/);
    expect(text, 'called a deleted id a name').not.toMatch(/where Actual expects/);
  }, 60_000);

  it('marks a broken action, not only a broken condition', async () => {
    await createFreshBudget(async () => {
      await api.createAccount({ name: 'Checking', offbudget: false } as never, 0);
      const group = await api.createCategoryGroup({ name: 'Spending' } as never);
      await api.createCategory({ name: 'Fun', group_id: group } as never);
    }, 'get-rules-bad-action');

    await api.createRule({
      stage: null,
      conditionsOp: 'and',
      conditions: [{ field: 'notes', op: 'contains', value: 'anything' }],
      actions: [{ op: 'set', field: 'category', value: 'Fun' }],
    } as never);

    const text = (await handlerFor()()).content[0].text;

    expect(text).toMatch(/stores "Fun" where Actual expects a category id/);
    expect(text).toMatch(/1 line above is marked/);
  }, 60_000);

  it('leaves a rule that matches nothing-in-particular alone', async () => {
    // `category is null` matches transactions with no category, and it fires:
    // measured, a row imported without one comes back marked by exactly that
    // rule. Calling it broken invites deleting a rule that works, and
    // create_rule cannot write it back.
    let acct = '';
    await createFreshBudget(async () => {
      acct = await api.createAccount({ name: 'Checking', offbudget: false } as never, 0);
      const group = await api.createCategoryGroup({ name: 'Spending' } as never);
      await api.createCategory({ name: 'Fun', group_id: group } as never);
    }, 'get-rules-null');

    await api.createRule({
      stage: null,
      conditionsOp: 'and',
      conditions: [{ field: 'category', op: 'is', value: null }],
      actions: [{ op: 'set', field: 'notes', value: 'uncategorised' }],
    } as never);
    await api.createRule({
      stage: null,
      conditionsOp: 'and',
      conditions: [{ field: 'payee', op: 'is', value: null }],
      actions: [{ op: 'set', field: 'notes', value: 'no payee' }],
    } as never);
    await api.createRule({
      stage: null,
      conditionsOp: 'and',
      conditions: [{ field: 'notes', op: 'contains', value: 'clear it' }],
      actions: [{ op: 'set', field: 'category', value: null }],
    } as never);

    const text = (await handlerFor()()).content[0].text;

    expect(text, 'a working rule was called broken').not.toMatch(/warning/);
    // And it reads as nothing rather than as the word null.
    expect(text).toContain('IF category is (none)');
    expect(text).toContain('THEN set category = (none)');
    expect(text).not.toContain('"null"');

    // The rule really does fire, which is why marking it would be wrong.
    await api.importTransactions(acct, [
      { date: '2026-09-01', amount: -1234, payee_name: 'Anyone' },
    ] as never);
    for (let i = 0; i < 4; i += 1) await api.getCategories();
    const rows = (await api.getTransactions(acct, '2026-09-01', '2026-09-01')) as Array<
      Record<string, unknown>
    >;
    expect(rows[0]?.notes).toContain('uncategorised');
  }, 60_000);

  it('marks an empty list, which matches nothing', async () => {
    await createFreshBudget(async () => {
      await api.createAccount({ name: 'Checking', offbudget: false } as never, 0);
      await api.createPayee({ name: 'Netflix' } as never);
      const group = await api.createCategoryGroup({ name: 'Spending' } as never);
      await api.createCategory({ name: 'Fun', group_id: group } as never);
    }, 'get-rules-empty-list');

    await api.createRule({
      stage: null,
      conditionsOp: 'and',
      conditions: [{ field: 'payee', op: 'oneOf', value: [] }],
      actions: [{ op: 'set', field: 'notes', value: 'marked' }],
    } as never);

    const text = (await handlerFor()()).content[0].text;

    expect(text).toContain('IF payee oneOf (empty list)');
    expect(text).toMatch(/an empty list matches nothing, so this never fires/);
  }, 60_000);

  it('does not tell anyone to delete a rule over a missing account', async () => {
    // A closed account is unreachable here: measured, neither getAccounts,
    // with or without options, nor a query filtered on `closed` returns one.
    // So this cannot tell closed from deleted, and the person may only need
    // to reopen it.
    let closed = '';
    await createFreshBudget(async () => {
      await api.createAccount({ name: 'Checking', offbudget: false } as never, 0);
      closed = await api.createAccount({ name: 'Old Card', offbudget: false } as never, 0);
      const group = await api.createCategoryGroup({ name: 'Spending' } as never);
      await api.createCategory({ name: 'Fun', group_id: group } as never);
    }, 'get-rules-closed');

    await api.createRule({
      stage: null,
      conditionsOp: 'and',
      conditions: [{ field: 'account', op: 'is', value: closed }],
      actions: [{ op: 'set', field: 'notes', value: 'marked' }],
    } as never);
    await api.closeAccount(closed as never);
    for (let i = 0; i < 4; i += 1) await api.getCategories();

    const text = (await handlerFor()()).content[0].text;

    expect(text).toMatch(/deleted, or closed/);
    expect(text).toMatch(/Reopen the account/);
    expect(text, 'told someone to delete a rule over a closed account').not.toMatch(
      /Recreate the rule or delete it/,
    );
  }, 60_000);

  it('says an id in the wrong case is the wrong case', async () => {
    // Measured: the engine compares ids exactly, so the rule really does not
    // fire. "No longer exists" would send someone looking for something that
    // is sitting right there.
    await createFreshBudget(async () => {
      await api.createAccount({ name: 'Checking', offbudget: false } as never, 0);
      await api.createPayee({ name: 'Netflix' } as never);
      const group = await api.createCategoryGroup({ name: 'Spending' } as never);
      await api.createCategory({ name: 'Fun', group_id: group } as never);
    }, 'get-rules-case');
    const payee = (await api.getPayees()).find((p) => p.name === 'Netflix')!.id;

    await api.createRule({
      stage: null,
      conditionsOp: 'and',
      conditions: [{ field: 'payee', op: 'is', value: payee.toUpperCase() }],
      actions: [{ op: 'set', field: 'notes', value: 'marked' }],
    } as never);

    const text = (await handlerFor()()).content[0].text;

    expect(text).toMatch(/written in a different case/);
    expect(text).toContain('Netflix');
    expect(text).not.toMatch(/no longer in the budget/);
  }, 60_000);
});
