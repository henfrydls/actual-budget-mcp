import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

vi.mock('@actual-app/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@actual-app/api')>();
  return { ...actual, sync: vi.fn().mockResolvedValue(undefined) };
});
vi.mock('../../../connection.js', () => ({
  ensureConnection: vi.fn().mockResolvedValue(undefined),
}));

import { initTestEngine, shutdownTestEngine, createFreshBudget, api } from './actual-engine.js';
import { getTransactionsReport } from '../../read/get-transactions.js';

const skip = process.env.SKIP_ACTUAL_INTEGRATION === '1';

/**
 * Notes are where the conventions live. A whole reimbursement workflow is built
 * on tagging them, and until now there was no way to ask for them.
 *
 * The half of this that was invisible: a note written on the parent of a split
 * was dropped entirely when the split was expanded into its parts, so it could
 * be written and never read back. Measured on a real budget, 12 of 15 splits
 * carry one, and they are the ones holding the meaning.
 */
describe.skipIf(skip)('searching notes (#82)', () => {
  beforeAll(async () => { await initTestEngine(); }, 60_000);
  afterAll(async () => { await shutdownTestEngine(); });

  async function budget() {
    let checking = '';
    let cat = '';
    await createFreshBudget(async () => {
      checking = await api.createAccount({ name: 'Checking', type: 'checking' } as any, 0);
      const g = await api.createCategoryGroup({ name: 'G' } as any);
      cat = await api.createCategory({ name: 'Comida', group_id: g } as any);
    });
    await api.addTransactions(checking, [
      { date: '2026-06-05', amount: -100, notes: 'Reembolso #Soventix RP-1234' },
      { date: '2026-06-06', amount: -200, notes: 'nada que ver' },
      { date: '2026-06-07', amount: -300 },
      { date: '2026-06-08', amount: -400, notes: 'otro #soventix en minúscula' },
      {
        date: '2026-06-09',
        amount: -500,
        notes: 'Cena #Soventix con el equipo',
        subtransactions: [
          { amount: -300, category: cat, notes: 'mi parte' },
          { amount: -200, category: cat },
        ],
      },
    ] as any);
    return { checking };
  }

  const search = (notes_contains: string) =>
    getTransactionsReport({
      notes_contains,
      start_date: '2026-06-01',
      end_date: '2026-06-30',
    });

  it('finds a tag in an ordinary note', async () => {
    await budget();

    const report = await search('#Soventix');

    expect(report).toMatch(/RP-1234/);
    expect(report).not.toMatch(/nada que ver/);
  });

  it('ignores case, including on accented text', async () => {
    await budget();

    // Spanish notes are the case this exists for, and folding only one side
    // would match text the reader cannot see.
    expect(await search('#SOVENTIX')).toMatch(/minúscula/);
    expect(await search('MINÚSCULA')).toMatch(/minúscula/);
  });

  it('finds a tag written on the parent of a split', async () => {
    // The half that was invisible: this note belongs to the purchase, which is
    // the parent, and a reimbursable purchase split across categories is
    // exactly where it lands.
    await budget();

    const report = await search('Cena #Soventix');

    expect(report).toMatch(/mi parte/);
    expect(report).toMatch(/Cena #Soventix con el equipo/);
  });

  it('shows the parent note on every part, in its own column', async () => {
    await budget();

    const report = await getTransactionsReport({
      start_date: '2026-06-09',
      end_date: '2026-06-09',
    });

    expect(report).toMatch(/Split of/);
    // Both parts carry it, including the one with no note of its own.
    expect(report.match(/Cena #Soventix con el equipo/g)?.length).toBe(2);
  });

  it('leaves the column empty for transactions that are not splits', async () => {
    // Asserted on the row itself, with a split in the same window so the
    // column is populated somewhere. The previous version only checked that a
    // note from another date was absent, which was true whatever the column
    // held: filling it on every ordinary row left the suite green.
    await budget();

    const report = await getTransactionsReport({
      start_date: '2026-06-01',
      end_date: '2026-06-30',
    });

    const ordinary = report.split('\n').find((l) => l.includes('RP-1234'))!;
    const part = report.split('\n').find((l) => l.includes('mi parte'))!;

    expect(ordinary).toBeTruthy();
    expect(ordinary.trimEnd()).toMatch(/[✓✗]$/);
    expect(part).toMatch(/Cena #Soventix con el equipo/);
  });

  it('marks a split part even when the parent has no note', async () => {
    // Removing the old `[Split]` prefix left these indistinguishable from an
    // ordinary transaction: three of fifteen splits on a real budget have no
    // note on the parent, and someone reconciling would see the parts as
    // separate charges.
    let checking = '';
    let cat = '';
    await createFreshBudget(async () => {
      checking = await api.createAccount({ name: 'Checking', type: 'checking' } as any, 0);
      const g = await api.createCategoryGroup({ name: 'G' } as any);
      cat = await api.createCategory({ name: 'Comida', group_id: g } as any);
    });
    await api.addTransactions(checking, [
      {
        date: '2026-06-09',
        amount: -500,
        subtransactions: [
          { amount: -300, category: cat },
          { amount: -200, category: cat },
        ],
      },
    ] as any);

    const report = await getTransactionsReport({
      start_date: '2026-06-01',
      end_date: '2026-06-30',
    });

    expect(report.match(/part of a split/g)?.length).toBe(2);
  });

  it('keeps the new column after the existing ones', async () => {
    // Appended, so nothing reading this table by position moves. Only the
    // order of the two adjacent columns fixes that.
    await budget();

    const report = await getTransactionsReport({
      start_date: '2026-06-01',
      end_date: '2026-06-30',
    });

    expect(report.indexOf('Notes')).toBeLessThan(report.indexOf('Cleared'));
    expect(report.indexOf('Cleared')).toBeLessThan(report.indexOf('Split of'));
  });

  it('searches every date when none is given, as the tag carries no date', async () => {
    // Looking for #Soventix to chase a reimbursement is not a question about
    // this month, and answering with the month's rows reads as "no
    // reimbursements pending".
    let checking = '';
    await createFreshBudget(async () => {
      checking = await api.createAccount({ name: 'Checking', type: 'checking' } as any, 0);
    });
    await api.addTransactions(checking, [
      { date: '2019-03-02', amount: -100, notes: 'viejo #Soventix' },
      { date: '2027-11-30', amount: -200, notes: 'futuro #Soventix' },
    ] as any);

    const report = await getTransactionsReport({ notes_contains: '#Soventix' });

    expect(report).toMatch(/viejo/);
    expect(report).toMatch(/futuro/);
  });

  it('ignores surrounding spaces in the search term', async () => {
    await budget();

    // The note ends with this word, so a trailing space decides the result. A
    // term surrounded by spaces inside the note would match either way, which
    // is how the first version of this test passed without the trimming.
    expect(await search('minúscula ')).toMatch(/minúscula/);
    expect(await search(' Reembolso')).toMatch(/RP-1234/);
  });

  it('treats a blank search as no search at all', async () => {
    await budget();

    const empty = await getTransactionsReport({
      notes_contains: '   ',
      start_date: '2026-06-01',
      end_date: '2026-06-30',
    });

    expect(empty).toMatch(/nada que ver/);
  });

  it('matches nothing rather than everything when the text is absent', async () => {
    await budget();

    expect(await search('no existe en ninguna nota')).toMatch(/No transactions found/i);
  });

  it('composes with a date range and an account', async () => {
    await budget();

    // The window has to hold more than the one row that should come back, or
    // the filter cannot be seen to act: with a single-row window, deleting the
    // filter entirely left this test green.
    const report = await getTransactionsReport({
      notes_contains: '#Soventix',
      account: 'Checking',
      start_date: '2026-06-01',
      end_date: '2026-06-08',
    });

    expect(report).toMatch(/RP-1234/);
    expect(report).toMatch(/minúscula/);
    expect(report).not.toMatch(/nada que ver/);
    expect(report).not.toMatch(/Cena/);
  });

  it('searches the payee by partial name, which already worked', async () => {
    // Recorded because the issue claimed otherwise: this half needed nothing.
    let checking = '';
    await createFreshBudget(async () => {
      checking = await api.createAccount({ name: 'Checking', type: 'checking' } as any, 0);
    });
    await api.addTransactions(checking, [
      { date: '2026-06-05', amount: -100, payee_name: 'Claro Dominicana' },
      { date: '2026-06-06', amount: -200, payee_name: 'Starlink' },
    ] as any);

    const report = await getTransactionsReport({
      payee: 'clar',
      start_date: '2026-06-01',
      end_date: '2026-06-30',
    });

    expect(report).toMatch(/Claro Dominicana/);
    expect(report).not.toMatch(/Starlink/);
  });
});
