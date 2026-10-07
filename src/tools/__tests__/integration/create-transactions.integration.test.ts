import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

vi.mock('@actual-app/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@actual-app/api')>();
  return { ...actual, sync: vi.fn().mockResolvedValue(undefined) };
});

vi.mock('../../../connection.js', () => ({
  ensureConnection: vi.fn().mockResolvedValue(undefined),
}));

import { initTestEngine, shutdownTestEngine, createFreshBudget, api } from './actual-engine.js';
import { createTransactions } from '../../write/create-transactions.js';

const skip = process.env.SKIP_ACTUAL_INTEGRATION === '1';

/**
 * `create_transactions` (#83) against the real engine.
 *
 * The batch is all-or-nothing by validating first, so the assertion that
 * matters throughout is the **row count**, not the wording of the reply: a
 * batch that reports failure while having written something is the failure
 * this design exists to prevent.
 */
describe.skipIf(skip)('create_transactions', () => {
  let checking = '';
  let savings = '';
  let comida = '';
  let transporte = '';

  async function budget(name: string, seed?: () => Promise<void>) {
    await createFreshBudget(async () => {
      checking = await api.createAccount({ name: 'Checking', type: 'checking' } as never, 0);
      savings = await api.createAccount({ name: 'Savings', type: 'checking' } as never, 0);
      const g = await api.createCategoryGroup({ name: 'Gastos' } as never);
      comida = await api.createCategory({ name: 'Comida', group_id: g } as never);
      transporte = await api.createCategory({ name: 'Transporte', group_id: g } as never);
      if (seed) await seed();
    }, name);
  }

  const count = async (acct: string) =>
    (await api.getTransactions(acct, '1900-01-01', '2999-12-31')).length;

  beforeAll(async () => {
    await initTestEngine();
  }, 60_000);

  afterAll(async () => {
    await shutdownTestEngine();
  });

  it('writes the whole batch in one go', async () => {
    await budget('batch-clean');
    const before = await count(checking);

    const lines = await createTransactions({
      transactions: [
        { account: 'Checking', amount: -125.5, payee: 'Supermercado', category: 'Comida', date: '2026-09-01' },
        { account: 'Checking', amount: -48.25, payee: 'Gasolina', category: 'Transporte', date: '2026-09-02' },
        { account: 'Checking', amount: -9.99, payee: 'Farmacia', date: '2026-09-03' },
      ],
    });

    expect(await count(checking)).toBe(before + 3);
    expect(lines[0]).toContain('Created 3 transactions');
    expect(lines.join('\n')).toContain(`Checking: ${before} -> ${before + 3}`);
  }, 60_000);

  it('writes nothing when one row names a category that does not exist', async () => {
    // The engine accepts a nonexistent category id and writes the row, measured.
    // The count is the assertion; the wording is secondary.
    await budget('batch-bad-category');
    const before = await count(checking);

    const lines = await createTransactions({
      transactions: [
        { account: 'Checking', amount: -100, category: 'Comida', date: '2026-09-01' },
        { account: 'Checking', amount: -200, category: 'No Existe', date: '2026-09-02' },
        { account: 'Checking', amount: -300, category: 'Transporte', date: '2026-09-03' },
      ],
    });

    expect(await count(checking)).toBe(before);
    const text = lines.join('\n');
    expect(text).toContain('Nothing was created');
    expect(text).toContain('row 2');
    expect(text).toContain('No category found matching "No Existe"');
    // The good rows are not reported as failures of their own.
    expect(text).toContain('The other 2 rows were fine');
  }, 60_000);

  it('writes nothing when one row has an unusable amount', async () => {
    await budget('batch-bad-amount');
    const before = await count(checking);

    const lines = await createTransactions({
      transactions: [
        { account: 'Checking', amount: -100, date: '2026-09-01' },
        { account: 'Checking', amount: Number.NaN, date: '2026-09-02' },
      ],
    });

    expect(await count(checking)).toBe(before);
    expect(lines.join('\n')).toContain('amount must be a number');
  }, 60_000);

  it('names a row that repeats another row in the same call', async () => {
    // The case the single-row duplicate check has never seen, because until
    // now two identical rows could not arrive together. Measured: the engine
    // writes both.
    await budget('batch-internal-dup');
    const before = await count(checking);

    const lines = await createTransactions({
      transactions: [
        { account: 'Checking', amount: -50, date: '2026-09-01', payee: 'Colmado' },
        { account: 'Checking', amount: -75, date: '2026-09-01', payee: 'Otro' },
        { account: 'Checking', amount: -50, date: '2026-09-01', payee: 'Colmado' },
      ],
    });

    expect(await count(checking)).toBe(before);
    expect(lines.join('\n')).toContain('repeats row 1');
  }, 60_000);

  it('writes rows that repeat each other when told to', async () => {
    await budget('batch-internal-dup-allowed');
    const before = await count(checking);

    await createTransactions({
      allow_duplicate: true,
      transactions: [
        { account: 'Checking', amount: -50, date: '2026-09-01', payee: 'Colmado' },
        { account: 'Checking', amount: -50, date: '2026-09-01', payee: 'Colmado' },
      ],
    });

    expect(await count(checking)).toBe(before + 2);
  }, 60_000);

  it('refuses a row that repeats something already in the budget', async () => {
    await budget('batch-existing-dup', async () => {
      await api.addTransactions(checking, [
        { date: '2026-09-01', amount: -5000, payee_name: 'Colmado' },
      ] as never);
    });
    const before = await count(checking);

    const lines = await createTransactions({
      transactions: [
        { account: 'Checking', amount: -50, date: '2026-09-01', payee: 'Colmado' },
        { account: 'Checking', amount: -60, date: '2026-09-02', payee: 'Otro' },
      ],
    });

    expect(await count(checking)).toBe(before);
    expect(lines.join('\n')).toContain('already has a transaction on 2026-09-01');
  }, 60_000);

  it('refuses a row whose imported_id is already in the budget', async () => {
    // Measured: `addTransactions` does not deduplicate on imported_id, it
    // writes a second row. So resending a batch would duplicate it, and this
    // is what stops that.
    await budget('batch-imported-id', async () => {
      await api.addTransactions(checking, [
        { date: '2026-09-01', amount: -5000, imported_id: 'bank-abc' },
      ] as never);
    });
    const before = await count(checking);

    const lines = await createTransactions({
      transactions: [
        { account: 'Checking', amount: -70, date: '2026-09-05', imported_id: 'bank-abc' },
      ],
    });

    expect(await count(checking)).toBe(before);
    expect(lines.join('\n')).toContain('already in the budget');
  }, 60_000);

  it('refuses two rows in the same call that share an imported_id (#143)', async () => {
    // The check above asks the budget; this one has to ask the batch. The two
    // rows differ in date and amount on purpose, so the account/date/amount
    // rule cannot be what catches them: all they share is the bank's id, and
    // that is enough, because a bank id identifies one movement.
    //
    // Measured before this existed: `Created 2 transactions.` and two rows,
    // while the tool's own description promises resending cannot duplicate it.
    await budget('batch-same-imported-id');
    const before = await count(checking);

    const lines = await createTransactions({
      transactions: [
        { account: 'Checking', amount: -8, date: '2026-09-10', imported_id: 'BANK-NEW' },
        { account: 'Checking', amount: -9, date: '2026-09-11', imported_id: 'BANK-NEW' },
      ],
    });

    expect(await count(checking)).toBe(before);
    const text = lines.join('\n');
    expect(text).toContain('same imported_id');
    expect(text).toContain('BANK-NEW');
    // Not the account/date/amount wording: those differ, and offering
    // `allow_duplicate` here would be advice that writes the same movement
    // twice.
    expect(text).not.toContain('same account, date and amount');
  }, 60_000);

  it('names the first row, not just the second, when three share an id', async () => {
    // Keys are recorded for every row whether or not it was flagged, so the
    // third row is compared against the first rather than against nothing.
    await budget('batch-three-same-id');

    const lines = await createTransactions({
      transactions: [
        { account: 'Checking', amount: -8, date: '2026-09-10', imported_id: 'BANK-X' },
        { account: 'Checking', amount: -9, date: '2026-09-11', imported_id: 'BANK-X' },
        { account: 'Checking', amount: -10, date: '2026-09-12', imported_id: 'BANK-X' },
      ],
    });

    const text = lines.join('\n');
    expect(text).toContain('repeats row 1');
    expect(text.match(/same imported_id/g)?.length).toBe(2);
  }, 60_000);

  it('complains once about a row that repeats another two ways', async () => {
    // Identical rows carrying the same id trip both checks. Two complaints
    // about one row read as two problems and send the reader looking for two
    // fixes.
    await budget('batch-both-ways');

    const lines = await createTransactions({
      transactions: [
        { account: 'Checking', amount: -8, date: '2026-09-10', imported_id: 'BANK-Y' },
        { account: 'Checking', amount: -8, date: '2026-09-10', imported_id: 'BANK-Y' },
      ],
    });

    const complaints = lines.join('\n').match(/repeats row 1/g) ?? [];
    expect(complaints).toHaveLength(1);
  }, 60_000);

  it('still matches a later row against one already flagged', async () => {
    // Keys are recorded for a flagged row too, and this is the only shape that
    // shows it. Row 2 is caught by its bank id; row 3 shares row 2's account,
    // date and amount and nothing else. If a flagged row stopped contributing
    // keys, row 3 would have nothing to match and would be written.
    await budget('batch-flagged-still-counts');
    const before = await count(checking);

    const lines = await createTransactions({
      transactions: [
        { account: 'Checking', amount: -8, date: '2026-09-10', imported_id: 'BANK-Z' },
        { account: 'Checking', amount: -9, date: '2026-09-11', imported_id: 'BANK-Z' },
        { account: 'Checking', amount: -9, date: '2026-09-11' },
      ],
    });

    expect(await count(checking)).toBe(before);
    const text = lines.join('\n');
    expect(text).toContain('same imported_id');
    // Row 3 against row 2, which was itself refused.
    expect(text).toContain('repeats row 2');
    // Two of three: the first row is what the other two repeat, so it is not
    // itself a problem, and the batch is still all-or-nothing.
    expect(text).toContain('2 of 3 rows could not be used');
  }, 60_000);

  it('writes rows with different ids that are otherwise identical', async () => {
    // The guard must not catch what it is not for: two genuine movements of
    // the same amount on the same day, each with its own bank id, still need
    // `allow_duplicate` for the other rule and nothing more.
    await budget('batch-different-ids');
    const before = await count(checking);

    const lines = await createTransactions({
      transactions: [
        { account: 'Checking', amount: -8, date: '2026-09-10', imported_id: 'BANK-A' },
        { account: 'Checking', amount: -8, date: '2026-09-10', imported_id: 'BANK-B' },
      ],
      allow_duplicate: true,
    });

    expect(await count(checking)).toBe(before + 2);
    expect(lines.join('\n')).toContain('Created 2 transactions');
  }, 60_000);

  it('keeps an explicit category against a learned payee mapping', async () => {
    // #26, per row. The learned payee→category mapping is applied on add, and
    // without `learnCategories: false` plus the correction afterwards it would
    // silently replace what the caller asked for.
    let catX = '';
    let catY = '';
    const budgetId = await createFreshBudget(async () => {
      checking = await api.createAccount({ name: 'Checking', type: 'checking' } as never, 0);
      const g = await api.createCategoryGroup({ name: 'Grp' } as never);
      catX = await api.createCategory({ name: 'CatX', group_id: g } as never);
      catY = await api.createCategory({ name: 'CatY', group_id: g } as never);
      await api.addTransactions(
        checking,
        [
          { date: '2026-05-01', amount: -100, payee_name: 'Vendor', category: catX },
          { date: '2026-05-02', amount: -200, payee_name: 'Vendor', category: catX },
          { date: '2026-05-03', amount: -300, payee_name: 'Vendor', category: catX },
        ] as never,
        { learnCategories: true, runTransfers: false },
      );
    }, 'batch-learned');

    await createTransactions({
      transactions: [
        { account: 'Checking', amount: -9.99, payee: 'Vendor', category: 'CatY', date: '2026-06-05' },
        { account: 'Checking', amount: -19.99, payee: 'Vendor', category: 'CatY', date: '2026-06-06' },
      ],
    });

    await api.loadBudget(budgetId);
    const rows = await api.getTransactions(checking, '2026-06-01', '2026-06-30');
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.category).toBe(catY);
      expect(row.category).not.toBe(catX);
    }
  }, 60_000);

  it('does not teach the budget new payee mappings', async () => {
    // What `learnCategories: false` actually changes, measured: with it on,
    // three rows for one payee teach the mapping, and a later row for that
    // payee with no category is filled in with it. With it off, that row stays
    // uncategorised.
    //
    // This is the assertion the flag needed. Mutating it to `true` left the
    // suite green, because the explicit category is corrected afterwards by
    // marker either way, so the other tests could not see the difference.
    //
    // It matters because a batch is how someone records a day's movements with
    // categories they chose by hand. Letting that teach mappings would change
    // how every later bank import categorises itself, which nobody asked for.
    let acct = '';
    let catX = '';
    const budgetId = await createFreshBudget(async () => {
      acct = await api.createAccount({ name: 'Checking', type: 'checking' } as never, 0);
      const g = await api.createCategoryGroup({ name: 'Grp' } as never);
      catX = await api.createCategory({ name: 'CatX', group_id: g } as never);
    }, 'batch-teaches-nothing');

    await createTransactions({
      transactions: [
        { account: 'Checking', amount: -1, payee: 'NuevoVendor', category: 'CatX', date: '2026-05-01' },
        { account: 'Checking', amount: -2, payee: 'NuevoVendor', category: 'CatX', date: '2026-05-02' },
        { account: 'Checking', amount: -3, payee: 'NuevoVendor', category: 'CatX', date: '2026-05-03' },
      ],
    });

    await api.loadBudget(budgetId);
    await api.addTransactions(
      acct,
      [{ date: '2026-06-01', amount: -400, payee_name: 'NuevoVendor' }] as never,
      { learnCategories: false } as never,
    );

    const later = await api.getTransactions(acct, '2026-06-01', '2026-06-01');
    expect(later).toHaveLength(1);
    expect(later[0].category).not.toBe(catX);
  }, 60_000);

  it('spreads a batch across the accounts its rows name', async () => {
    // `addTransactions` writes to the account it is given and ignores an
    // `account` on the row, measured, so the batch is grouped per account.
    await budget('batch-two-accounts');
    const beforeChecking = await count(checking);
    const beforeSavings = await count(savings);

    const lines = await createTransactions({
      transactions: [
        { account: 'Checking', amount: -10, date: '2026-09-01' },
        { account: 'Savings', amount: -20, date: '2026-09-02' },
        { account: 'Checking', amount: -30, date: '2026-09-03' },
      ],
    });

    expect(await count(checking)).toBe(beforeChecking + 2);
    expect(await count(savings)).toBe(beforeSavings + 1);
    const text = lines.join('\n');
    expect(text).toContain('Checking:');
    expect(text).toContain('Savings:');
  }, 60_000);

  it('refuses a row whose payee names an account', async () => {
    await budget('batch-transfer');
    const before = await count(checking);

    const lines = await createTransactions({
      transactions: [
        { account: 'Checking', amount: -10, date: '2026-09-01' },
        { account: 'Checking', amount: -500, payee: 'Savings', date: '2026-09-02' },
      ],
    });

    expect(await count(checking)).toBe(before);
    expect(lines.join('\n')).toContain('create_transfer');
  }, 60_000);

  it('refuses an ambiguous account rather than guessing', async () => {
    await createFreshBudget(async () => {
      await api.createAccount({ name: 'BHD Nomina', type: 'checking' } as never, 0);
      await api.createAccount({ name: 'BHD Nomina USD', type: 'checking' } as never, 0);
    }, 'batch-ambiguous');

    const lines = await createTransactions({
      transactions: [{ account: 'BHD', amount: -10, date: '2026-09-01' }],
    });

    expect(lines.join('\n').toLowerCase()).toContain('ambiguous');
  }, 60_000);

  it('reports every unusable row at once, not just the first', async () => {
    await budget('batch-many-problems');

    const lines = await createTransactions({
      transactions: [
        { account: 'Checking', amount: -10, date: '2026-09-01' },
        { account: 'No Such Account', amount: -20, date: '2026-09-02' },
        { account: 'Checking', amount: -30, category: 'No Existe', date: '2026-09-03' },
      ],
    });

    const text = lines.join('\n');
    expect(text).toContain('2 of 3 rows could not be used');
    expect(text).toContain('row 2');
    expect(text).toContain('row 3');
  }, 60_000);
});
