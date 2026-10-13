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
 * A rule about a cleared or reconciled transaction (#185).
 *
 * Actual stores these fields as a boolean, and this tool passed through the
 * string it was given. Measured against the engine, that failed in two
 * different ways, because the engine checks a condition's value and does not
 * check an action's:
 *
 *   condition `cleared is "true"`   refused: "Value must be a boolean", which
 *                                   reached the caller as a bare "Failed
 *                                   creating a new rule". No rule about a
 *                                   cleared transaction could be made here.
 *
 *   action `set cleared = "false"`  saved as the word, and then read for its
 *                                   truth. A string that is not empty is true,
 *                                   so the rule marked every transaction it
 *                                   matched as cleared: the opposite of what
 *                                   was asked, on every import, silently.
 *
 * So the checks are that the rule is created, that the engine holds a boolean,
 * and that a transaction actually gets it, both ways round. The last one is
 * what proves the rule runs and means what it says.
 */
describe.skipIf(skip)('rules about a boolean field (#185)', () => {
  let accountId = '';
  let categoryId = '';

  beforeAll(async () => {
    await initTestEngine();
    await createFreshBudget(async () => {
      accountId = (await api.createAccount({ name: 'Checking', offbudget: false } as never, 0)) as string;
      const group = await api.createCategoryGroup({ name: 'Spending' } as never);
      categoryId = (await api.createCategory({ name: 'Fun', group_id: group } as never)) as string;
    }, 'rule-booleans');
  }, 60_000);

  afterAll(async () => {
    await shutdownTestEngine();
  });

  /** The conditions of every rule in the budget. */
  async function storedConditions(): Promise<unknown[]> {
    const rules = (await api.getRules()) as { conditions?: unknown[] }[];
    return rules.flatMap((rule) => rule.conditions ?? []);
  }

  /** The rows in the account, once the import has settled. */
  async function rowsAfter(notes: string): Promise<Record<string, unknown>[]> {
    let rows: Record<string, unknown>[] = [];
    for (let attempt = 0; attempt < 8; attempt += 1) {
      rows = (await api.getTransactions(accountId, '2000-01-01', '2100-01-01')) as never;
      if (rows.some((r) => r.notes === notes)) break;
    }
    return rows;
  }

  it('stores the word as the boolean the engine holds', async () => {
    await createRuleFromInput({
      condition_field: 'cleared',
      condition_op: 'is',
      condition_value: 'true',
      action_field: 'category',
      action_value: 'Fun',
    } as never);

    expect(await storedConditions()).toContainEqual(
      expect.objectContaining({ field: 'cleared', op: 'is', value: true }),
    );
  });

  it('categorises a cleared transaction and leaves an uncleared one alone', async () => {
    // The end-to-end check, and the only one that shows the rule running.
    // Before this, no rule on `cleared` could be created at all.
    await api.importTransactions(accountId, [
      { date: '2026-10-12', amount: -100, payee_name: 'Cinema', imported_id: 'bool-1', notes: 'was-cleared', cleared: true } as never,
      { date: '2026-10-12', amount: -200, payee_name: 'Theatre', imported_id: 'bool-2', notes: 'not-cleared', cleared: false } as never,
    ]);

    const rows = await rowsAfter('not-cleared');
    const cleared = rows.find((r) => r.notes === 'was-cleared');
    const pending = rows.find((r) => r.notes === 'not-cleared');
    expect(cleared, 'the cleared transaction was not imported').toBeDefined();
    expect(pending, 'the uncleared transaction was not imported').toBeDefined();
    expect(cleared!.category, 'the rule did not fire on the cleared row').toBe(categoryId);
    expect(pending!.category, 'the rule fired on a row it should not match').toBeNull();
  });

  it('takes a condition on reconciled too, not only on cleared', async () => {
    await createRuleFromInput({
      condition_field: 'reconciled',
      condition_op: 'is',
      condition_value: 'false',
      action_field: 'notes',
      action_value: 'not settled yet',
    } as never);

    expect(await storedConditions()).toContainEqual(
      expect.objectContaining({ field: 'reconciled', op: 'is', value: false }),
    );
  });

  it('refuses the two boolean fields a condition can never be answered on', async () => {
    // The engine has four boolean fields and two of them are a trap. A rule
    // is evaluated against a transaction plus the two things the engine adds
    // to it, and neither `transfer` nor `parent` is ever among them: the
    // condition is answered `undefined` and comes back false, for ever.
    //
    // Measured, and this is the test that would catch Actual fixing it: a
    // rule `transfer is true` against a transaction imported with an account
    // payee, which the engine turns into a real transfer. The row came out
    // with its transfer_id set and its notes untouched, in all three stages,
    // on first import and on re-import. The same for `parent` against a
    // split. Before this fix the string was refused by the engine, so these
    // rules could not be written here at all; converting the value is what
    // would have made them reachable.
    for (const field of ['transfer', 'parent']) {
      const message = await createRuleFromInput({
        condition_field: field,
        condition_op: 'is',
        condition_value: 'true',
        action_field: 'notes',
        action_value: 'never',
      } as never).catch((e: Error) => e.message);

      expect(message, field).toContain(`cannot match on \`${field}\``);
      expect(message, field).toContain('never runs the rule on its own');
      expect(message, 'it has to say what can be matched on').toContain('cleared');
    }

    // And nothing was created on the way to saying so.
    const conditions = await storedConditions();
    for (const field of ['transfer', 'parent']) {
      expect(conditions.map((c) => (c as { field?: string }).field)).not.toContain(field);
    }
  });

  it('says what each of those fields was asking, since its name does not', async () => {
    // `parent is true` does not read as "a split", and the refusal is where
    // somebody finds out what they were reaching for and that it is not
    // there. Both are named, because only one of them being right is how a
    // wrong wording survives.
    const transfer = await createRuleFromInput({
      condition_field: 'transfer',
      condition_op: 'is',
      condition_value: 'true',
      action_field: 'notes',
      action_value: 'never',
    } as never).catch((e: Error) => e.message);
    expect(transfer).toContain('whether a transaction is part of a transfer');

    const parent = await createRuleFromInput({
      condition_field: 'parent',
      condition_op: 'is',
      condition_value: 'true',
      action_field: 'notes',
      action_value: 'never',
    } as never).catch((e: Error) => e.message);
    expect(parent).toContain('whether a transaction is a split parent');
  });

  it('tells a field Actual knows apart from one it has never heard of', async () => {
    // Two different fixes: one is a field that exists and cannot work, the
    // other is a typo. Saying "it would never fire" about a typo sends
    // somebody looking for a rule that was never saved.
    const typo = await createRuleFromInput({
      condition_field: 'transferred',
      condition_op: 'is',
      condition_value: 'true',
      action_field: 'notes',
      action_value: 'never',
    } as never).catch((e: Error) => e.message);

    expect(typo).toContain('no rule field called');
    expect(typo).not.toContain('never runs the rule');
    expect(typo, 'it still has to name what does work').toContain('cleared');
  });

  it('leaves a transaction uncleared when the rule says false, which used to clear it', async () => {
    // The measured inversion. Stored as the word, "false" was read for its
    // truth and marked the transaction cleared, so a rule written to say "not
    // cleared" did the one thing it was written to prevent.
    await createRuleFromInput({
      condition_field: 'notes',
      condition_op: 'is',
      condition_value: 'make-it-pending',
      action_field: 'cleared',
      action_value: 'false',
    } as never);

    const actions = ((await api.getRules()) as { actions?: { field?: string; value?: unknown }[] }[])
      .flatMap((rule) => rule.actions ?? []);
    expect(actions).toContainEqual(expect.objectContaining({ field: 'cleared', value: false }));

    // Imported already cleared, so the only thing that can clear it back down
    // is the rule: a row that starts uncleared would pass either way.
    await api.importTransactions(accountId, [
      { date: '2026-10-14', amount: -300, payee_name: 'Shop', imported_id: 'bool-3', notes: 'make-it-pending', cleared: true } as never,
    ]);

    const row = (await rowsAfter('make-it-pending')).find((r) => r.notes === 'make-it-pending');
    expect(row, 'the transaction was not imported').toBeDefined();
    expect(row!.cleared, 'the rule marked it cleared, which is the bug').toBe(false);
  });

  it('marks a transaction reconciled when the rule says true', async () => {
    await createRuleFromInput({
      condition_field: 'notes',
      condition_op: 'is',
      condition_value: 'settle-it',
      action_field: 'reconciled',
      action_value: 'yes',
    } as never);

    await api.importTransactions(accountId, [
      { date: '2026-10-15', amount: -400, payee_name: 'Bank', imported_id: 'bool-4', notes: 'settle-it', cleared: false } as never,
    ]);

    const row = (await rowsAfter('settle-it')).find((r) => r.notes === 'settle-it');
    expect(row, 'the transaction was not imported').toBeDefined();
    expect(row!.reconciled, 'the rule did not fire').toBe(true);
  });

  it('says which way round it read it, in both halves of a rule', async () => {
    // The reading is the thing that was wrong, so it is said back in words. A
    // rule runs until somebody deletes it, and this is the one chance to see
    // that "false" means what it says.
    const condition = await createRuleFromInput({
      condition_field: 'cleared',
      condition_op: 'is',
      condition_value: 'false',
      action_field: 'notes',
      action_value: 'pending',
    } as never);
    expect(condition.join('\n')).toContain(
      'Condition cleared: false, so the rule matches transactions that are not cleared',
    );

    const action = await createRuleFromInput({
      condition_field: 'notes',
      condition_op: 'is',
      condition_value: 'say-it-back',
      action_field: 'cleared',
      action_value: 'false',
    } as never);
    expect(action.join('\n')).toContain(
      'Action cleared: false, so matching transactions are marked not cleared',
    );

    const theOtherWay = await createRuleFromInput({
      condition_field: 'notes',
      condition_op: 'is',
      condition_value: 'say-it-back-true',
      action_field: 'cleared',
      action_value: 'true',
    } as never);
    expect(theOtherWay.join('\n')).toContain(
      'Action cleared: true, so matching transactions are marked cleared',
    );
  });

  it('reads each spelling as the one value it means, in any case', async () => {
    // One rule per spelling, each found again by its own condition, because
    // counting how many came out false says nothing about which did. "1" and
    // "0" are the pair worth pinning: both are words to the engine, so both
    // read as true where they are stored as written, and "0" meaning true is
    // the opposite of what anybody writing it means.
    const spellings: [string, boolean][] = [
      ['TRUE', true],
      ['Yes', true],
      ['1', true],
      ['False', false],
      ['no', false],
      ['0', false],
      ['  true  ', true],
    ];

    for (const [written] of spellings) {
      await createRuleFromInput({
        condition_field: 'notes',
        condition_op: 'is',
        condition_value: `spelling ${written}`,
        action_field: 'cleared',
        action_value: written,
      } as never);
    }

    const rules = (await api.getRules()) as {
      conditions?: { field?: string; value?: unknown }[];
      actions?: { field?: string; value?: unknown }[];
    }[];

    for (const [written, means] of spellings) {
      const rule = rules.find((r) =>
        (r.conditions ?? []).some((c) => c.value === `spelling ${written}`),
      );
      expect(rule, `no rule was stored for "${written}"`).toBeDefined();
      const action = (rule!.actions ?? []).find((a) => a.field === 'cleared');
      expect(action?.value, `"${written}" was read as the wrong one`).toBe(means);
    }
  });

  it('takes a value that arrives as a boolean or a number, not only as text', async () => {
    // What a client writes when it fills this from JSON. Measured before:
    // `action_value: true` was answered "Expected string, received boolean",
    // and called directly it reached `.trim` and threw about a function that
    // does not exist on a boolean.
    for (const [given, means] of [
      [true, true],
      [false, false],
      [1, true],
      [0, false],
    ] as [boolean | number, boolean][]) {
      await createRuleFromInput({
        condition_field: 'notes',
        condition_op: 'is',
        condition_value: `shape ${String(given)} ${typeof given}`,
        action_field: 'cleared',
        action_value: given,
      } as never);

      const rules = (await api.getRules()) as {
        conditions?: { value?: unknown }[];
        actions?: { field?: string; value?: unknown }[];
      }[];
      const rule = rules.find((r) =>
        (r.conditions ?? []).some((c) => c.value === `shape ${String(given)} ${typeof given}`),
      );
      expect(rule, `nothing stored for ${typeof given} ${String(given)}`).toBeDefined();
      const action = (rule!.actions ?? []).find((a) => a.field === 'cleared');
      expect(action?.value, `${typeof given} ${String(given)}`).toBe(means);
    }

    // And a condition value of the same shape.
    await createRuleFromInput({
      condition_field: 'cleared',
      condition_op: 'is',
      condition_value: true,
      action_field: 'notes',
      action_value: 'given as a boolean',
    } as never);
    expect(await storedConditions()).toContainEqual(
      expect.objectContaining({ field: 'cleared', op: 'is', value: true }),
    );
  });

  it('does not answer a list with an operator the field cannot take either', async () => {
    // The general answer to a list is `oneOf`, and on a boolean the engine
    // refuses `oneOf` outright, so naming it is the same broken promise as
    // sending someone to `isNot`.
    const message = await createRuleFromInput({
      condition_field: 'cleared',
      condition_op: 'is',
      condition_value: ['true'],
      action_field: 'notes',
      action_value: 'hm',
    } as never).catch((e: Error) => e.message);

    expect(message).toContain('takes one value, not a list');
    expect(message).not.toContain('oneOf');
    expect(message, 'it has to say why a list is pointless here').toContain(
      'matches every transaction',
    );
  });

  it('refuses a value that is neither, instead of storing it as true', async () => {
    // The engine's own answer for the condition is "Failed creating a new
    // rule", and for the action there is no answer at all: it is saved, and
    // every transaction it matches is marked cleared.
    const message = await createRuleFromInput({
      condition_field: 'cleared',
      condition_op: 'is',
      condition_value: 'maybe',
      action_field: 'notes',
      action_value: 'hm',
    } as never).catch((e: Error) => e.message);

    expect(message).toContain('"maybe"');
    expect(message, 'it has to say what to write instead').toContain('true, yes or 1');
    expect(message, 'and what it would have meant').toContain('read as true');
    expect(message).not.toContain('Failed creating a new rule');
  });

  it('refuses an empty value instead of taking it for false', async () => {
    // `""` was the one value the engine read as false, so an action with
    // nothing in it marked matching transactions not cleared. Nothing asked
    // for that, and nothing said it had happened.
    for (const empty of ['', '   ']) {
      await expect(
        createRuleFromInput({
          condition_field: 'notes',
          condition_op: 'is',
          condition_value: 'empty-boolean',
          action_field: 'cleared',
          action_value: empty,
        } as never),
        `action with "${empty}"`,
      ).rejects.toThrow(/needs true or false/);
    }
  });

  it('says what the empty value would have done, where it would have done it', async () => {
    // An empty value means the same thing in both halves and does two very
    // different things with it, and the sentence that names neither leaves
    // the reader to work out which one they are looking at.
    const action = await createRuleFromInput({
      condition_field: 'notes',
      condition_op: 'is',
      condition_value: 'empty-here',
      action_field: 'reconciled',
      action_value: '',
    } as never).catch((e: Error) => e.message);
    expect(action).toContain('mark every transaction it matches as not reconciled');

    const condition = await createRuleFromInput({
      condition_field: 'cleared',
      condition_op: 'is',
      condition_value: '   ',
      action_field: 'notes',
      action_value: 'hm',
    } as never).catch((e: Error) => e.message);
    expect(condition).toContain('match only transactions that are not cleared');
    // The two sentences are not interchangeable: an action writes and a
    // condition selects, and saying the wrong one sends the reader looking
    // for the wrong half of their rule.
    expect(condition).not.toContain('mark every transaction');
  });

  it('refuses the operators the engine does not take on a boolean', async () => {
    // Measured, one rule per operator: `is` is the only one. `isNot`,
    // `oneOf`, `contains`, `gt` and `isapprox` each come back as the bare
    // message this tool exists to replace.
    const message = await createRuleFromInput({
      condition_field: 'cleared',
      condition_op: 'isNot',
      condition_value: 'true',
      action_field: 'notes',
      action_value: 'hm',
    } as never).catch((e: Error) => e.message);

    expect(message).toContain('isNot');
    expect(message, 'it has to name the one that does work').toContain('`is`');
    expect(message).not.toContain('Failed creating a new rule');
    // The way out of `isNot` is the other value, and that advice belongs to
    // `isNot` alone.
    expect(message).toContain('use `is` with false');
  });

  it('does not give the isNot advice for an operator it does not answer', async () => {
    // `contains` on a boolean is refused for a different reason, and "use `is`
    // with false" reads as a non sequitur there.
    const message = await createRuleFromInput({
      condition_field: 'cleared',
      condition_op: 'contains',
      condition_value: 'true',
      action_field: 'notes',
      action_value: 'hm',
    } as never).catch((e: Error) => e.message);

    expect(message).toContain('contains');
    expect(message).toContain('`is`');
    expect(message).not.toContain('use `is` with false');
  });

  it('names what works when a list is tried on a boolean', async () => {
    // The list refusal used to send everyone to `is` or `isNot`, and `isNot`
    // is not one the engine takes here.
    const message = await createRuleFromInput({
      condition_field: 'cleared',
      condition_op: 'oneOf',
      condition_value: ['true', 'false'],
      action_field: 'notes',
      action_value: 'hm',
    } as never).catch((e: Error) => e.message);

    expect(message).toContain('`is` with true or false');
    expect(message).not.toContain('isNot');
  });
});
