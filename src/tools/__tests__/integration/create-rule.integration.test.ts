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

  it('refuses a payee "contains" rule, which compares against the id (#169)', async () => {
    // This used to be left as text and created. The engine compares
    // `contains` on `payee` against the payee's id, so the rule fires on
    // whatever happens to have those characters in its UUID and never on the
    // payee that was meant.
    const before = (await api.getRules()).length;
    await expect(
      createRuleFromInput({
        condition_field: 'payee',
        condition_op: 'contains',
        condition_value: 'Amaz',
        action_field: 'category',
        action_value: 'Groceries',
      }),
    ).rejects.toThrow(/cannot use `contains` on `payee`[\s\S]*imported_payee/);
    expect((await api.getRules()).length).toBe(before);
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

/**
 * Text operators on the fields Actual stores by id (#169).
 *
 * `payee contains "Netfl"` never matches Netflix and `payee contains "-"`
 * matches nearly everything, because a UUID is mostly hyphens. The engine
 * accepts the rule, lists it like any other, and it quietly recategorises
 * transactions that have nothing to do with what was asked for.
 */
describe.skipIf(skip)('a text operator on a field stored by id', () => {
  let fun = '';
  let acct = '';

  beforeAll(async () => {
    await initTestEngine();
    await createFreshBudget(async () => {
      acct = await api.createAccount({ name: 'Checking', offbudget: false } as never, 0);
      await api.createPayee({ name: 'Netflix' } as never);
      const group = await api.createCategoryGroup({ name: 'Spending' } as never);
      fun = await api.createCategory({ name: 'Fun', group_id: group } as never);
    }, 'rule-text-ops');
    void fun;
  }, 60_000);

  afterAll(async () => {
    await shutdownTestEngine();
  });

  const FIELDS = ['payee', 'category', 'category_group', 'account'] as const;
  const OPS = ['contains', 'doesNotContain', 'matches'] as const;

  for (const field of FIELDS) {
    for (const op of OPS) {
      it(`refuses ${op} on ${field}, and saves nothing`, async () => {
        const before = (await api.getRules()).length;

        await expect(
          createRuleFromInput({
            condition_field: field,
            condition_op: op,
            condition_value: 'Fun',
            action_field: 'notes',
            action_value: 'marked',
          }),
        ).rejects.toThrow(new RegExp(`cannot use \`${op}\` on \`${field}\``));

        expect((await api.getRules()).length, 'a rule was created anyway').toBe(before);
      }, 60_000);
    }
  }

  it('is the field the engine itself calls an id, not a list someone typed', async () => {
    // `category_group` was missing from the first version of this, because the
    // issue named three fields and nobody checked the fourth. Measured: a
    // rule `category_group doesNotContain "Spending"` fires on a transaction
    // in Spending, which is the same damage as the others.
    const before = (await api.getRules()).length;

    await expect(
      createRuleFromInput({
        condition_field: 'category_group',
        condition_op: 'doesNotContain',
        condition_value: 'Spending',
        action_field: 'notes',
        action_value: 'marked',
      }),
    ).rejects.toThrow(/cannot use `doesNotContain` on `category_group`/);
    expect((await api.getRules()).length).toBe(before);
  }, 60_000);

  it('names both text fields for a payee, and promises neither', async () => {
    // An earlier version said `payee_name` worked whether the transaction came
    // from a bank or was entered here. It does not: the engine fills that
    // field in only when the payee already exists, so the first charge under
    // a name nobody has seen is exactly the one it misses. Advice that is
    // wrong in the case someone cares about is worse than no advice.
    const message = await createRuleFromInput({
      condition_field: 'payee',
      condition_op: 'contains',
      condition_value: 'Netfl',
      action_field: 'notes',
      action_value: 'marked',
    }).catch((e: Error) => e.message);

    expect(message).toMatch(/imported_payee/);
    expect(message).toMatch(/payee_name/);
    expect(message).toMatch(/only once that payee exists/);
    expect(message, 'promised one of them works everywhere').not.toMatch(
      /whether the transaction came from|works on any/,
    );
  }, 60_000);

  it('does not offer oneOf, which does not work through this tool yet', async () => {
    // Sending `oneOf` from here fails outright: the engine wants an array and
    // a single string goes out. Advice that cannot be followed is worse than
    // no advice, because it costs a round trip to find out.
    for (const field of FIELDS) {
      const message = await createRuleFromInput({
        condition_field: field,
        condition_op: 'contains',
        condition_value: 'whatever',
        action_field: 'notes',
        action_value: 'marked',
      }).catch((e: Error) => e.message);

      expect(message, `${field} was told to use oneOf`).not.toMatch(/oneOf/);
    }
  }, 60_000);

  it('points account and category_group at an id, since a name is not resolved there yet', async () => {
    // Measured: `account is "Checking"` is stored as the name and never
    // fires, while `account is <id>` does. Telling someone to use a name
    // would hand them a rule that does nothing.
    for (const field of ['account', 'category_group'] as const) {
      const message = await createRuleFromInput({
        condition_field: field,
        condition_op: 'contains',
        condition_value: 'whatever',
        action_field: 'notes',
        action_value: 'marked',
      }).catch((e: Error) => e.message);

      expect(message).toMatch(new RegExp(`Use \`is\` with the ${field} id`));
    }
  }, 60_000);

  it('still allows a text operator on imported_payee, which holds text', async () => {
    // The field someone reaching for `payee contains` usually wants.
    const lines = await createRuleFromInput({
      condition_field: 'imported_payee',
      condition_op: 'contains',
      condition_value: 'NETFL',
      action_field: 'category',
      action_value: 'Fun',
    });
    const rules = await api.getRules();
    const stored = rules.find((r) => r.id === lines.find((l) => l.includes('ID:'))!.split('ID:')[1].trim());
    expect((stored as { conditions: Array<{ value: unknown }> }).conditions[0].value).toBe('NETFL');
  }, 60_000);

  it('still allows `is` on those fields, which is what they are for', async () => {
    const lines = await createRuleFromInput({
      condition_field: 'category',
      condition_op: 'is',
      condition_value: 'Fun',
      action_field: 'notes',
      action_value: 'marked',
    });
    const rules = await api.getRules();
    const stored = rules.find((r) => r.id === lines.find((l) => l.includes('ID:'))!.split('ID:')[1].trim());
    expect((stored as { conditions: Array<{ value: unknown }> }).conditions[0].value).toBe(fun);
    void acct;
  }, 60_000);
});

/**
 * Why a text rule on a payee name is not the whole answer (#169, round 3).
 *
 * The engine fills `payee_name` in from the transaction's payee, and a payee
 * that does not exist yet is created after the rules have run. So the first
 * charge from a shop, under whatever name the bank writes, is the one a text
 * rule on the name misses, which is the case someone writing the rule cares
 * most about.
 */
describe.skipIf(skip)('a text rule on a payee that does not exist yet', () => {
  let acct = '';

  beforeAll(async () => {
    await initTestEngine();
    await createFreshBudget(async () => {
      acct = await api.createAccount({ name: 'Checking', offbudget: false } as never, 0);
      // One payee exists from the start, the other does not.
      await api.createPayee({ name: 'Netflix' } as never);
    }, 'rule-new-payee');

    await api.createRule({
      stage: null,
      conditionsOp: 'and',
      conditions: [{ field: 'payee_name', op: 'contains', value: 'Netfl' }],
      actions: [{ op: 'set', field: 'notes', value: 'FIRED' }],
    } as never);
  }, 60_000);

  afterAll(async () => {
    await shutdownTestEngine();
  });

  const importOne = async (date: string, payeeName: string) => {
    await api.importTransactions(acct, [
      { date, amount: -2500, payee_name: payeeName },
    ] as never);
    for (let i = 0; i < 4; i += 1) await api.getCategories();
    const rows = (await api.getTransactions(acct, date, date)) as Array<Record<string, unknown>>;
    return rows[0];
  };

  it('fires when the payee already exists', async () => {
    const row = await importOne('2026-09-01', 'Netflix');
    expect(row?.notes).toBe('FIRED');
  }, 60_000);

  it('does not fire on the first charge under a name nobody has seen', async () => {
    // Which is why the refusal names this limit instead of selling the field
    // as the answer.
    const row = await importOne('2026-09-02', 'Netflix Intl');
    expect(row?.notes ?? null).toBeNull();
  }, 60_000);
});
