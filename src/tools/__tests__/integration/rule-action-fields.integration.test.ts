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
 * The fields a rule can set, which is fewer than the engine accepts (#187).
 *
 * An action writes its value onto the transaction object and the engine then
 * inserts that object, so a field that is not a column on `transactions` is
 * either dropped or fatal. The engine does not check, so the rule is created
 * either way and what it costs lands on whoever next imports something that
 * matches it.
 *
 * Measured, one rule per field in the engine's own table, each with a real
 * import: `category_group` does nothing, and `saved`, `transfer` and `parent`
 * take the whole import down. The tests below pin both the refusal and the
 * engine behaviour the refusal is built on, so that a later version of Actual
 * that stops doing this fails here rather than being refused out of habit.
 */
describe.skipIf(skip)('a rule that sets a field Actual keeps no column for (#187)', () => {
  let accountId = '';
  let categoryId = '';

  beforeAll(async () => {
    await initTestEngine();
    await createFreshBudget(async () => {
      accountId = (await api.createAccount({ name: 'Checking', offbudget: false } as never, 0)) as string;
      const group = await api.createCategoryGroup({ name: 'Spending' } as never);
      categoryId = (await api.createCategory({ name: 'Fun', group_id: group } as never)) as string;
    }, 'rule-action-fields');
  }, 60_000);

  afterAll(async () => {
    await shutdownTestEngine();
  });

  it('refuses the three that take the next import down, and says so', async () => {
    for (const field of ['saved', 'transfer', 'parent']) {
      const message = await createRuleFromInput({
        condition_field: 'notes',
        condition_op: 'is',
        condition_value: `set-${field}`,
        action_field: field,
        action_value: 'true',
      } as never).catch((e: Error) => e.message);

      expect(message, field).toContain(`cannot set \`${field}\``);
      // The refusal carries the consequence, because the rule itself looks
      // ordinary and the failure turns up on a different day.
      expect(message, field).toContain(`Field "${field}" does not exist on table transactions`);
      expect(message, field).toContain('none of the three');
    }
  });

  it('refuses the one that quietly does nothing, for the reason it does nothing', async () => {
    // A different cost and a different sentence: this rule never breaks
    // anything, it just never files a transaction, which is the kind of thing
    // nobody goes looking for.
    const message = await createRuleFromInput({
      condition_field: 'notes',
      condition_op: 'is',
      condition_value: 'set-group',
      action_field: 'category_group',
      action_value: 'Spending',
    } as never).catch((e: Error) => e.message);

    expect(message).toContain('cannot set `category_group`');
    expect(message).toContain('do nothing at all');
    expect(message, 'it points at the one that does work').toContain('category');
    expect(message).not.toContain('does not exist on table transactions');
  });

  it('tells a field Actual knows apart from a typo', async () => {
    const message = await createRuleFromInput({
      condition_field: 'notes',
      condition_op: 'is',
      condition_value: 'set-typo',
      action_field: 'categry',
      action_value: 'Fun',
    } as never).catch((e: Error) => e.message);

    expect(message).toContain('no rule field called');
    expect(message).not.toContain('does not exist on table transactions');
  });

  it('creates nothing on the way to refusing any of them', async () => {
    const rules = (await api.getRules()) as { actions?: { field?: string }[] }[];
    const fields = rules.flatMap((rule) => rule.actions ?? []).map((a) => a.field);
    for (const field of ['saved', 'transfer', 'parent', 'category_group', 'categry']) {
      expect(fields, field).not.toContain(field);
    }
  });

  it('still sets the fields that do work, including the ones not named before', async () => {
    // The other way a list like this goes wrong: too narrow, and a rule
    // somebody could write stops working. `date` and `imported_payee` are in
    // the engine's table and were never offered by this tool's description.
    await createRuleFromInput({
      condition_field: 'notes',
      condition_op: 'is',
      condition_value: 'move-the-date',
      action_field: 'date',
      action_value: '2026-11-30',
    } as never);
    await createRuleFromInput({
      condition_field: 'notes',
      condition_op: 'is',
      condition_value: 'rename-the-import',
      action_field: 'imported_payee',
      action_value: 'As the bank wrote it',
    } as never);

    await api.importTransactions(accountId, [
      { date: '2026-10-20', amount: -100, notes: 'move-the-date', payee_name: 'A', imported_id: 'af-1' } as never,
      { date: '2026-10-21', amount: -200, notes: 'rename-the-import', payee_name: 'B', imported_id: 'af-2' } as never,
    ]);

    let rows: Record<string, unknown>[] = [];
    for (let attempt = 0; attempt < 8; attempt += 1) {
      rows = (await api.getTransactions(accountId, '2000-01-01', '2100-01-01')) as never;
      if (rows.some((r) => r.imported_id === 'af-2')) break;
    }
    expect(rows.find((r) => r.imported_id === 'af-1')?.date).toBe('2026-11-30');
    expect(rows.find((r) => r.imported_id === 'af-2')?.imported_payee).toBe('As the bank wrote it');
  });

  it('sets an amount a later import can actually use, from a number or a word', async () => {
    // The two shapes a client sends, and what makes offering `amount` as an
    // action safe at all. Before the conversion (#183) the figure was stored
    // as the text it was given, and the next import with a transaction
    // matching the rule died on `Can't convert to integer: "-45.50"` and
    // brought in none of its batch.
    for (const [tag, given] of [
      ['amount-as-text', '-45.50'],
      ['amount-as-number', -45.5],
    ] as [string, string | number][]) {
      await createRuleFromInput({
        condition_field: 'notes',
        condition_op: 'is',
        condition_value: tag,
        action_field: 'amount',
        action_value: given,
      } as never);
    }

    const actions = ((await api.getRules()) as { actions?: { field?: string; value?: unknown }[] }[])
      .flatMap((rule) => rule.actions ?? [])
      .filter((a) => a.field === 'amount');
    expect(actions, 'neither rule was created').toHaveLength(2);
    expect(actions.every((a) => a.value === -4550), 'stored as something other than the integer')
      .toBe(true);

    // And the import goes through, with the whole batch, at the figure the
    // rule says rather than the one the row arrived with.
    await api.importTransactions(accountId, [
      { date: '2026-10-18', amount: -100, notes: 'amount-as-text', payee_name: 'A', imported_id: 'amt-t' } as never,
      { date: '2026-10-19', amount: -100, notes: 'amount-as-number', payee_name: 'B', imported_id: 'amt-n' } as never,
      { date: '2026-10-19', amount: -700, notes: 'nothing to do with it', payee_name: 'C', imported_id: 'amt-o' } as never,
    ]);

    let rows: { amount: number; imported_id?: string | null }[] = [];
    for (let attempt = 0; attempt < 8; attempt += 1) {
      rows = (await api.getTransactions(accountId, '2000-01-01', '2100-01-01')) as never;
      if (rows.some((r) => r.imported_id === 'amt-o')) break;
    }
    expect(rows.find((r) => r.imported_id === 'amt-t')?.amount).toBe(-4550);
    expect(rows.find((r) => r.imported_id === 'amt-n')?.amount).toBe(-4550);
    // The row that had nothing to do with the rule arrived too, which is
    // what the version without the conversion lost.
    expect(rows.find((r) => r.imported_id === 'amt-o')?.amount).toBe(-700);
  });

  it('is refused because the engine loses the whole import, not the row', async () => {
    // Created around the tool, which is the only way to get one now. This is
    // the measurement the refusal is built on, and `saved` is here as well as
    // `transfer` because the first version of this refusal only knew about
    // the boolean fields and let `saved` through.
    for (const field of ['transfer', 'saved']) {
      const rule = (await api.createRule({
        stage: null,
        conditionsOp: 'and',
        conditions: [{ field: 'notes', op: 'is', value: `poison-${field}` }],
        actions: [{ op: 'set', field, value: true }],
      } as never)) as { id: string };

      const failure = await api
        .importTransactions(accountId, [
          { date: '2026-10-01', amount: -100, notes: 'ordinary one', payee_name: 'A', imported_id: `o1-${field}` } as never,
          { date: '2026-10-02', amount: -200, notes: `poison-${field}`, payee_name: 'B', imported_id: `p-${field}` } as never,
          { date: '2026-10-03', amount: -300, notes: 'ordinary two', payee_name: 'C', imported_id: `o2-${field}` } as never,
        ])
        .then(() => null)
        .catch((e: Error) => e.message);

      expect(failure, `the engine accepted the import with ${field} after all`).not.toBeNull();
      expect(failure!).toContain(`Field "${field}" does not exist on table transactions`);

      // The two rows that had nothing to do with the rule are gone as well,
      // which is what makes this worth refusing rather than warning about.
      const rows = (await api.getTransactions(accountId, '2000-01-01', '2100-01-01')) as {
        imported_id?: string | null;
      }[];
      const ids = rows.map((r) => r.imported_id);
      expect(ids, field).not.toContain(`o1-${field}`);
      expect(ids, field).not.toContain(`o2-${field}`);

      await api.deleteRule(rule.id);
    }
  });

  it('is refused on category_group because the engine files nothing', async () => {
    const rule = (await api.createRule({
      stage: null,
      conditionsOp: 'and',
      conditions: [{ field: 'notes', op: 'is', value: 'group-does-nothing' }],
      actions: [{ op: 'set', field: 'category_group', value: categoryId }],
    } as never)) as { id: string };

    await api.importTransactions(accountId, [
      { date: '2026-10-05', amount: -400, notes: 'group-does-nothing', payee_name: 'D', imported_id: 'g-1' } as never,
    ]);

    let rows: Record<string, unknown>[] = [];
    for (let attempt = 0; attempt < 8; attempt += 1) {
      rows = (await api.getTransactions(accountId, '2000-01-01', '2100-01-01')) as never;
      if (rows.some((r) => r.imported_id === 'g-1')) break;
    }
    const row = rows.find((r) => r.imported_id === 'g-1');
    expect(row, 'the row was not imported, so the rule did more than nothing').toBeDefined();
    expect(row!.category, 'the action filed the transaction after all').toBeNull();

    await api.deleteRule(rule.id);
  });
});
