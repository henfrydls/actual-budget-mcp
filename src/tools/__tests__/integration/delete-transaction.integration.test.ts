import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

vi.mock('@actual-app/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@actual-app/api')>();
  return { ...actual, sync: vi.fn().mockResolvedValue(undefined) };
});
vi.mock('../../../connection.js', () => ({
  ensureConnection: vi.fn().mockResolvedValue(undefined),
}));

import { initTestEngine, shutdownTestEngine, createFreshBudget, api } from './actual-engine.js';
import { deleteTransactionGuarded } from '../../write/delete-transaction.js';
import { transactionsQuery } from '../../../utils/transaction-query.js';

const skip = process.env.SKIP_ACTUAL_INTEGRATION === '1';

/**
 * The refusal, as this tool words it today.
 *
 * These assertions were first written as `not.toMatch(/not found/i)`, which was
 * the wording of the message this fix replaced. Nothing produces that phrase
 * any more, so the guard against #103 regressing could not fire: under every
 * mutation those tests fell on the `toContain` below instead. Anchored to the
 * live sentence, and to the one constant, so the two cannot drift apart again.
 */
const NOT_FOUND = /No transaction with id .* exists in this budget/;

function plusDays(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(
    d.getDate(),
  ).padStart(2, '0')}`;
}

/**
 * #103. Each of these rows is one the old lookup could not see, and for every
 * one of them the delete still went through on confirm: the preview was blank
 * and the destruction was real. They are separate tests rather than a loop so
 * that a failure names which kind of row went blind.
 */
describe.skipIf(skip)('delete_transaction previews every row it can destroy (#103)', () => {
  let open = '';
  let closed = '';
  let ids: Record<string, string> = {};
  let budgetId = '';
  // Read once. Calling plusDays() again inside an assertion would disagree
  // with the fixture across a midnight boundary.
  const AHEAD = plusDays(3);

  beforeAll(async () => {
    await initTestEngine();

    budgetId = await createFreshBudget(async () => {
      open = await api.createAccount({ name: 'Open', type: 'checking' } as never, 0);
      closed = await api.createAccount({ name: 'Old Card', type: 'credit' } as never, 0);
      const group = await api.createCategoryGroup({ name: 'G' } as never);
      const category = await api.createCategory({ name: 'Cat', group_id: group } as never);
      await api.addTransactions(
        open,
        [
          { date: AHEAD, amount: -1000, payee_name: 'DATED-AHEAD' },
          { date: '1998-05-01', amount: -2000, payee_name: 'BEFORE-2000' },
          {
            date: '2026-06-05',
            amount: -7000,
            payee_name: 'THE-SPLIT',
            subtransactions: [
              { amount: -4000, category },
              { amount: -3000, category },
            ],
          },
          { date: '2026-06-06', amount: -500, payee_name: 'ORDINARY' },
        ] as never,
        { learnCategories: false, runTransfers: false },
      );
      // Balanced, so the account can be closed without a transfer.
      await api.addTransactions(
        closed,
        [
          // Deliberately not 'IN-CLOSED': the assertion below looks for the word
          // "closed", and a payee containing it would satisfy the test from the
          // wrong row, which is the trap #96 already paid for.
          { date: '2026-06-07', amount: -900, payee_name: 'ON-THE-OLD-CARD' },
          { date: '2026-06-07', amount: 900, payee_name: 'OFFSET' },
        ] as never,
        { learnCategories: false, runTransfers: false },
      );
    });
    await api.closeAccount(closed);

    const result = await api.runQuery(
      transactionsQuery('all').select(['id', 'amount', 'is_child', 'is_parent']),
    );
    const rows = (result as { data: Array<Record<string, unknown>> }).data;
    const byAmount = (amount: number, child = false) =>
      String(rows.find((r) => r.amount === amount && Boolean(r.is_child) === child)!.id);

    ids = {
      ahead: byAmount(-1000),
      old: byAmount(-2000),
      child: byAmount(-4000, true),
      splitParent: byAmount(-7000),
      inClosed: byAmount(-900),
      ordinary: byAmount(-500),
    };
  }, 120_000);

  afterAll(async () => {
    await shutdownTestEngine();
  });

  const previewOf = async (id: string) => {
    const result = await deleteTransactionGuarded({ transaction_id: id });
    expect(result.deleted, 'the first call must never delete').toBe(false);
    return result.lines.join('\n');
  };

  it('a row dated after today, which is how a card posts a weekend purchase', async () => {
    const text = await previewOf(ids.ahead);

    expect(text).not.toMatch(NOT_FOUND);
    expect(text).toContain('DATED-AHEAD');
    expect(text).toContain(AHEAD);
  });

  it('a row older than the date floor the scan used to start at', async () => {
    const text = await previewOf(ids.old);

    expect(text).not.toMatch(NOT_FOUND);
    expect(text).toContain('BEFORE-2000');
    expect(text).toContain('1998-05-01');
  });

  it('one part of a split, which getTransactions nests out of sight', async () => {
    const text = await previewOf(ids.child);

    expect(text).not.toMatch(NOT_FOUND);
    // These come before the positive one on purpose. Under `grouped` the
    // preview carries the parent, so asserting -40.00 first would report
    // "the amount is missing" when what happened is "the wrong row came back".
    // Not the id: the confirmation subject echoes the id that was *asked for*,
    // so asserting it would pass whatever row came back. What separates the
    // child from its parent is what the preview says about it. `grouped`,
    // which is what `getTransactions` fixes internally, resolves a child id to
    // its parent: measured, `all` and `inline` return the child while
    // `grouped` returns the -70.00 parent. So the parent's amount and the
    // parent's warning are the two things that must not appear.
    expect(text).not.toMatch(/-70\.00/);
    expect(text).not.toMatch(/split parent/i);
    expect(text).toMatch(/-40\.00/);
    expect(text).toMatch(/one part of a split/i);
    // The consequences, not just the label. Measured: the balance moves by the
    // part's amount, and the parent is left stating a total its parts no
    // longer reach.
    expect(text).toMatch(/moves the account balance by 40\.00/);
    expect(text).toMatch(/parts no longer add up to/);
  });

  it('a split parent, warned about as one, which is the costliest row here', async () => {
    // The other half of the pair. `is_child` was covered against the engine
    // and `is_parent` was not: removing it from the select left the whole
    // suite green in both modes while this warning vanished, so a parent and
    // every child under it could be destroyed without the preview saying so.
    // The same failure this PR exists to fix, on the row that costs most.
    const text = await previewOf(ids.splitParent);

    expect(text).not.toMatch(NOT_FOUND);
    expect(text).toMatch(/-70\.00/);
    expect(text).toContain('THE-SPLIT');
    expect(text).toMatch(/split parent/i);
    expect(text).toMatch(/child transactions are deleted with it/i);
    // And not mistaken for one of its own parts, which carries the opposite
    // warning.
    expect(text).not.toMatch(/one part of a split/i);
  });

  it('and deleting that parent really does take its children', async () => {
    // The warning above states a consequence, so the consequence is measured
    // rather than trusted. Its own budget, because it destroys the fixture it
    // uses and the others share theirs.
    let acct = '';
    const ownBudget = await createFreshBudget(async () => {
      acct = await api.createAccount({ name: 'Solo', type: 'checking' } as never, 0);
      const group = await api.createCategoryGroup({ name: 'GS' } as never);
      const category = await api.createCategory({ name: 'CS', group_id: group } as never);
      await api.addTransactions(
        acct,
        [
          {
            date: '2026-06-05',
            amount: -7000,
            payee_name: 'GOING-WITH-CHILDREN',
            subtransactions: [
              { amount: -4000, category },
              { amount: -3000, category },
            ],
          },
        ] as never,
        { learnCategories: false, runTransfers: false },
      );
    });

    // Everything that can throw sits inside the try, and the shared budget
    // goes back in the finally. Restoring before the last assertion only was
    // one exit path out of three: a failure in the precondition or in
    // `deleted` left the other budget loaded, and the three tests after this
    // one then read the wrong one and failed too. That is the same disguise
    // this restore exists to remove, coming back through the doors it did not
    // cover.
    let after = -1;
    try {
      const before = (
        (await api.runQuery(transactionsQuery('all').select(['id']))) as { data: unknown[] }
      ).data.length;
      // A precondition rather than a behavioural assertion: with a fixture of
      // one row, `after === 0` would pass while proving nothing about children.
      expect(before, 'a parent and two children').toBe(3);

      const parent = String(
        (
          (await api.runQuery(
            transactionsQuery('all').filter({ is_parent: true }).select(['id']),
          )) as { data: Array<{ id: string }> }
        ).data[0].id,
      );
      const result = await deleteTransactionGuarded({ transaction_id: parent, confirm: true });
      expect(result.deleted).toBe(true);

      await api.loadBudget(ownBudget);
      after = (
        (await api.runQuery(transactionsQuery('all').select(['id']))) as { data: unknown[] }
      ).data.length;
    } finally {
      await api.loadBudget(budgetId);
    }

    expect(after, 'the parent and both children are gone').toBe(0);
  }, 60_000);

  it('a row in a closed account, named as closed rather than as missing', async () => {
    const text = await previewOf(ids.inClosed);

    expect(text).not.toMatch(NOT_FOUND);
    expect(text).toContain('Old Card');
    expect(text).toMatch(/closed/i);
  });

  it('still previews an ordinary row, which is the case that always worked', async () => {
    const text = await previewOf(ids.ordinary);

    expect(text).toContain('ORDINARY');
    expect(text).toContain('2026-06-06');
  });

  it('refuses an id that matches nothing, and destroys nothing', async () => {
    const before = await api.runQuery(
      transactionsQuery('all').select(['id']),
    );
    const countBefore = (before as { data: unknown[] }).data.length;

    const result = await deleteTransactionGuarded({
      transaction_id: '00000000-0000-4000-8000-000000000000',
      confirm: true,
    });

    expect(result.deleted).toBe(false);
    expect(result.lines.join('\n')).toMatch(NOT_FOUND);

    // Reloaded before counting. Without it this assertion passes while a real
    // row is being destroyed: the first read after a delete returns the state
    // from before it, so the count comes back unchanged whether or not
    // anything went. A count taken inside that window cannot count.
    await api.loadBudget(budgetId);
    const after = await api.runQuery(
      transactionsQuery('all').select(['id']),
    );
    expect((after as { data: unknown[] }).data.length).toBe(countBefore);
  });

  it('actually deletes the row it previewed, including one it used to miss', async () => {
    // Its own budget, and not only for tidiness. This used to delete a row
    // from the shared fixture that the first test in this file previews, so
    // the file passed in written order and failed under
    // `--sequence.shuffle.tests`, reproduced two runs in three. A test that
    // destroys shared state is a test whose neighbours pass because of where
    // they sit.
    let acct = '';
    let ahead = '';
    const ownBudget = await createFreshBudget(async () => {
      acct = await api.createAccount({ name: 'Solo Ahead', type: 'checking' } as never, 0);
      await api.addTransactions(
        acct,
        [{ date: AHEAD, amount: -1000, payee_name: 'DATED-AHEAD-SOLO' }] as never,
        { learnCategories: false, runTransfers: false },
      );
    });

    let survivors = -1;
    try {
      ahead = String(
        (
          (await api.runQuery(transactionsQuery('all').select(['id']))) as {
            data: Array<{ id: string }>;
          }
        ).data[0].id,
      );

      const result = await deleteTransactionGuarded({ transaction_id: ahead, confirm: true });
      expect(result.deleted).toBe(true);

      // Reloaded before reading: the first query after a delete returns the
      // state from before it, so without this the count is taken inside the
      // stale window and cannot count.
      await api.loadBudget(ownBudget);
      survivors = (
        (await api.runQuery(transactionsQuery('all').filter({ id: ahead }).select(['id']))) as {
          data: unknown[];
        }
      ).data.length;
    } finally {
      await api.loadBudget(budgetId);
    }

    expect(survivors, 'the row that used to be invisible is really gone').toBe(0);
  });
});
