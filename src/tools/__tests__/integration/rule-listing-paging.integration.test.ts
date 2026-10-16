import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

vi.mock('@actual-app/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@actual-app/api')>();
  return { ...actual, sync: vi.fn().mockResolvedValue(undefined) };
});
vi.mock('../../../connection.js', () => ({
  ensureConnection: vi.fn().mockResolvedValue(undefined),
}));

import { initTestEngine, shutdownTestEngine, createFreshBudget, api } from './actual-engine.js';
import { getRules } from '../../read/get-rules.js';
import { loadRuleNames, describeRule } from '../../../utils/rule-describe.js';

const skip = process.env.SKIP_ACTUAL_INTEGRATION === '1';

/**
 * Asking for fewer rules (#177).
 *
 * The listing is around 161 bytes a rule, so a budget holding 1500 of them
 * answers with 242 KB. The promise this release makes is that nothing changes
 * for anyone below the page: a budget with a hundred rules or fewer, asked
 * without arguments, gets the bytes it got before.
 */
describe.skipIf(skip)('asking get_rules for fewer rules', () => {
  let payeeId = '';
  let categoryId = '';

  /** A budget holding `count` plain rules, plus whatever else is asked for. */
  async function budgetOf(prefix: string, count: number, extra: unknown[] = []): Promise<void> {
    await createFreshBudget(async () => {
      await api.createAccount({ name: 'Checking', offbudget: false } as never, 0);
      payeeId = (await api.createPayee({ name: 'Shop' } as never)) as string;
      const group = await api.createCategoryGroup({ name: 'Spending' } as never);
      categoryId = (await api.createCategory({ name: 'Fun', group_id: group } as never)) as string;
    }, prefix);
    for (let index = 0; index < count; index += 1) {
      await api.createRule({
        stage: null,
        conditionsOp: 'and',
        conditions: [{ op: 'is', field: 'notes', value: `tag-${index}` }],
        actions: [{ op: 'set', field: 'category', value: categoryId }],
      } as never);
    }
    for (const rule of extra) await api.createRule(rule as never);
  }

  /** A rule that reads perfectly well and has never matched anything. */
  const marked = (notes: string) => ({
    stage: null,
    conditionsOp: 'and',
    conditions: [{ op: 'is', field: 'notes', value: notes }],
    actions: [{ op: 'set', field: 'transfer', value: true }],
  });

  beforeAll(async () => {
    await initTestEngine();
  }, 60_000);

  afterAll(async () => {
    await shutdownTestEngine();
  });

  it('answers a budget at the page with exactly the bytes it answered before', async () => {
    // Byte for byte, against the reply rebuilt from the same pieces: the
    // header, a blank line, and each rule written out in order. None of these
    // rules carries a warning, so there is no closing paragraph and the whole
    // reply is reconstructible here. That is what makes this a comparison
    // rather than a list of things that happen to be true.
    await budgetOf('paging-parity', 100);
    const rules = await api.getRules();
    expect(rules.length).toBe(100);

    const names = await loadRuleNames();
    const expected =
      `=== Rules (100) ===\n\n` +
      rules
        .map((rule) => {
          const described = describeRule(rule, names);
          return [
            `Rule: ${rule.id}`,
            `  Stage: ${described.stage} | Conditions: ${described.conditionsOp}`,
            ...described.conditions,
            ...described.actions,
            '',
          ].join('\n');
        })
        .join('\n');

    expect(await getRules()).toBe(expected);
  }, 120_000);

  it('says nothing about paging until there is something not listed', async () => {
    await budgetOf('paging-boundary', 100, [marked('poison')]);
    const text = await getRules();

    expect(text).toContain('Showing 1 to 100 of 101 rules. Pass offset: 100 for the next 1.');
  }, 120_000);

  it('says how many of the rules it did not list are marked', async () => {
    // The thing a page must not bury. The order is the engine's, so a marked
    // rule can be anywhere in it, and a page that says nothing about the rest
    // invites the reader to believe they have seen it all. Asked for one rule
    // so the marked one is certainly outside the page, whatever the order.
    await budgetOf('paging-unseen', 20, [marked('poison'), marked('poison-two')]);
    const text = await getRules({ limit: 1 });

    expect(text).toContain('2 of the 21 not listed carry a warning');
    expect(text).toContain('Showing 1 to 1 of 22 rules.');
    // The arguments that got this page, so the next one can be asked for
    // without working out which of them to repeat.
    expect(text).toContain('with limit: 1.');
    expect(text).toContain('Pass flagged_only: true to see them');
  }, 120_000);

  it('does not offer the marked ones to someone already asking for them', async () => {
    await budgetOf('paging-unseen-flagged', 20, [marked('poison'), marked('poison-two')]);
    const text = await getRules({ flagged_only: true, limit: 1 });

    expect(text).toContain(
      'Showing 1 to 1 of 2 matching rules. Pass offset: 1 for the next 1, with flagged_only: true and limit: 1.',
    );
    expect(text, 'they are already asking for the marked ones').not.toContain(
      'Pass flagged_only: true',
    );
  }, 120_000);

  it('gives the marked rules wherever they are in the order', async () => {
    await budgetOf('paging-flagged', 100, [marked('poison')]);
    const text = await getRules({ flagged_only: true });

    expect(text).toContain('Showing the 1 rule carrying a warning.');
    expect(text).toContain('Actual keeps no transfer column');
    // One rule, and the hundred plain ones are not in it.
    expect(text.match(/^Rule: /gm) ?? []).toHaveLength(1);
    expect(text, 'nothing is left unlisted, so there is nothing to page to').not.toContain(
      'Pass offset',
    );
  }, 120_000);

  it('counts the marked rules on both sides of the page', async () => {
    // On the second page the rules before it are no more listed than the ones
    // after, and counting only the tail called them seen. The marked rule
    // inside the page is seen, so it is not among them.
    await budgetOf('paging-both-sides', 0, [
      marked('before-one'),
      marked('before-two'),
      marked('inside'),
      marked('after'),
      marked('after-two'),
    ]);
    const text = await getRules({ limit: 1, offset: 2 });

    expect(text).toContain('Showing 3 to 3 of 5 rules.');
    expect(text).toContain('4 of the 4 not listed carry a warning');
  }, 120_000);

  it('keeps the header counting the whole budget when the list is filtered', async () => {
    // The header is the size of the budget; the line under it says what is
    // being shown. Making the header count the filtered ones would hide how
    // many rules there are from the only reply that lists them.
    await budgetOf('paging-header', 4, [marked('poison')]);
    const text = await getRules({ flagged_only: true });

    expect(text.split('\n')[0]).toBe('=== Rules (5) ===');
    expect(text).toContain('Showing the 1 rule carrying a warning.');
  }, 120_000);

  it('reads a field however it is capitalised', async () => {
    // One rule out of three, so the filter has to have done something: with
    // every rule matching there is nothing left out and nothing to say.
    await budgetOf('paging-field-case', 2, [
      {
        stage: null,
        conditionsOp: 'and',
        conditions: [{ op: 'is', field: 'payee', value: payeeId }],
        actions: [{ op: 'set', field: 'notes', value: 'seen' }],
      },
    ]);
    const text = await getRules({ field: '  Payee ' });

    expect(text).toContain('Showing the 1 rule that mentions payee.');
    expect(text.match(/^Rule: /gm) ?? []).toHaveLength(1);
  }, 120_000);

  it('finds the actions that carry no field of their own', async () => {
    // `set-split-amount` and `link-schedule` have no field, so the listing
    // prints the operation in its place and nothing would have found them.
    await budgetOf('paging-fieldless', 1, [
      {
        stage: null,
        conditionsOp: 'and',
        conditions: [{ op: 'is', field: 'notes', value: 'split-me' }],
        actions: [
          { op: 'set-split-amount', value: 50, options: { splitIndex: 1, method: 'remainder' } },
        ],
      },
      {
        stage: null,
        conditionsOp: 'and',
        conditions: [{ op: 'is', field: 'notes', value: 'link-me' }],
        actions: [{ op: 'link-schedule', value: 'sched-1' }],
      },
    ]);

    // What a split writes is the amount, so that is the field to find it by.
    expect((await getRules({ field: 'amount' })).match(/^Rule: /gm) ?? []).toHaveLength(1);
    // And `link-schedule` by its own name, since nothing else would reach it.
    expect((await getRules({ field: 'link-schedule' })).match(/^Rule: /gm) ?? []).toHaveLength(1);
  }, 120_000);

  it('gives the rules that mention one field', async () => {
    await budgetOf('paging-field', 3, [
      {
        stage: null,
        conditionsOp: 'and',
        conditions: [{ op: 'is', field: 'payee', value: payeeId }],
        actions: [{ op: 'set', field: 'notes', value: 'seen' }],
      },
    ]);
    const text = await getRules({ field: 'payee' });

    expect(text).toContain('Showing the 1 rule that mentions payee.');
    expect(text.match(/^Rule: /gm) ?? []).toHaveLength(1);
    // The field is read from the actions too, not only the conditions.
    expect((await getRules({ field: 'notes' })).match(/^Rule: /gm) ?? []).toHaveLength(4);
  }, 120_000);

  it('names the fields instead of answering that nothing matched', async () => {
    // An empty list reads as "you have no rules about that", which is a
    // different thing from "there is no such field".
    await budgetOf('paging-unknown-field', 2);
    const text = await getRules({ field: 'payee_nmae' });

    expect(text).toContain('Actual keeps no rule field called "payee_nmae"');
    expect(text).toContain('imported_payee');
  }, 120_000);

  it('pages, and says where the next page starts', async () => {
    await budgetOf('paging-offset', 5);
    const first = await getRules({ limit: 2 });
    const second = await getRules({ limit: 2, offset: 2 });

    expect(first).toContain(
      'Showing 1 to 2 of 5 rules. Pass offset: 2 for the next 2, with limit: 2.',
    );
    // The offset that gets the next page, not the size of this one: they are
    // the same number until the second page, which is where it was wrong.
    expect(second).toContain('Showing 3 to 4 of 5 rules. Pass offset: 4 for the next 1');
    expect(first.match(/^Rule: /gm) ?? []).toHaveLength(2);
    // The order is the engine's, so the pages follow one another.
    const ids = (await api.getRules()).map((rule) => rule.id);
    expect(first).toContain(`Rule: ${ids[0]}`);
    expect(second).toContain(`Rule: ${ids[2]}`);
    expect(second).not.toContain(`Rule: ${ids[0]}`);
  }, 120_000);

  it('says so rather than answering nothing when the page is past the end', async () => {
    await budgetOf('paging-past-end', 3);
    expect(await getRules({ offset: 10 })).toContain('Nothing to list at offset 10');
  }, 120_000);

  it('still says when a budget has no rules at all', async () => {
    await budgetOf('paging-empty', 0);
    expect(await getRules()).toBe('No rules configured.');
    expect(await getRules({ flagged_only: true })).toBe('No rules configured.');
  }, 120_000);

  it('says none carries a warning rather than listing nothing', async () => {
    await budgetOf('paging-none-flagged', 3);
    expect(await getRules({ flagged_only: true })).toBe(
      'None of your 3 rules carries a warning.',
    );
  }, 120_000);
});
