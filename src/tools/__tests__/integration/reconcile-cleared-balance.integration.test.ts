import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

vi.mock('@actual-app/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@actual-app/api')>();
  return { ...actual, sync: vi.fn().mockResolvedValue(undefined) };
});
vi.mock('../../../connection.js', () => ({
  ensureConnection: vi.fn().mockResolvedValue(undefined),
}));

import { initTestEngine, shutdownTestEngine, createFreshBudget, api } from './actual-engine.js';
import { reconcileCurrencyResidual } from '../../write/reconcile-currency-residual.js';
import { balanceBreakdown } from '../../../utils/account-balance.js';
import { formatMoney } from '../../../utils/money.js';

const skip = process.env.SKIP_ACTUAL_INTEGRATION === '1';

/**
 * What the adjustment is measured against, and what the reply says about it
 * (#108).
 *
 * A statement shows what has posted; `getAccountBalance` counts an uncleared
 * row too, so the two can measure different things. Comparing against the
 * cleared figure instead was measured against a real budget before being
 * rejected: most of the rows not marked cleared were weeks old and none had
 * come from a bank, so they were rows nobody ticked off rather than items in
 * flight, which clear in a day or two. That change would have booked the whole
 * accumulated difference as an adjustment into a residual category.
 *
 * **The figure is unchanged.** What these fix is that the reply now shows both
 * readings and what the other one would have produced, so the question is
 * visible without being answered on the caller's behalf.
 *
 * Every figure below is read back from the engine once the write has settled,
 * because this is a tool that moves money and a reply that describes an
 * adjustment it did not make is the failure worth catching.
 */
interface Row {
  date: string;
  amount: number;
  cleared: boolean;
  payee: string;
}

const TODAY = (() => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
})();

describe.skipIf(skip)('reconciling against what the bank has posted', () => {
  beforeAll(async () => {
    await initTestEngine();
  }, 60_000);

  afterAll(async () => {
    await shutdownTestEngine();
  });

  let acct = '';
  let category = '';

  async function budget(name: string, rows: Row[], extra?: () => Promise<void>) {
    const id = await createFreshBudget(async () => {
      acct = await api.createAccount({ name: 'Card (USD)', type: 'credit' } as never, 0);
      const group = await api.createCategoryGroup({ name: 'G' } as never);
      category = await api.createCategory({ name: 'Cashback', group_id: group } as never);
      await api.addTransactions(
        acct,
        rows.map((r) => ({
          date: r.date,
          amount: r.amount,
          cleared: r.cleared,
          payee_name: r.payee,
        })) as never,
        { learnCategories: false, runTransfers: false },
      );
      if (extra) await extra();
    }, name);
    // Settled before anything is measured.
    for (let i = 0; i < 6; i += 1) await api.getCategories();
    return id;
  }

  const rowsOn = async (date: string) =>
    (await api.getTransactions(acct, date, date)) as Array<Record<string, unknown>>;

  /**
   * The table. Each case is one account at one moment, with what the bank
   * says, and the adjustment that should close the gap against the posted
   * rows alone.
   */
  const CASES = [
    {
      label: 'no unmarked rows at all',
      rows: [{ date: '2026-05-01', amount: -10000, cleared: true, payee: 'drift' }],
      bank: 0,
      // -100.00 in the account, bank says 0, so +100.00.
      adjustment: 10000,
      uncleared: 0,
      // What the reply would offer as the other reading. Equal here, so it
      // says nothing at all.
      clearedOnlyAdjustment: 10000,
    },
    {
      label: 'an unmarked charge',
      rows: [
        { date: '2026-05-01', amount: -10000, cleared: true, payee: 'drift' },
        { date: '2026-05-02', amount: -2000, cleared: false, payee: 'not ticked off' },
      ],
      bank: 0,
      // The account is at -120.00 counting everything, which is what the
      // adjustment closes. Against the cleared rows alone it would be 100.00,
      // and the reply says so.
      adjustment: 12000,
      uncleared: 1,
      clearedOnlyAdjustment: 10000,
    },
    {
      label: 'an unmarked credit, which moves the figure the other way',
      rows: [
        { date: '2026-05-01', amount: -10000, cleared: true, payee: 'drift' },
        { date: '2026-05-02', amount: 3000, cleared: false, payee: 'refund not ticked off' },
      ],
      bank: 0,
      adjustment: 7000,
      uncleared: 1,
      clearedOnlyAdjustment: 10000,
    },
    {
      label: 'several unmarked rows either way',
      rows: [
        { date: '2026-05-01', amount: -10000, cleared: true, payee: 'drift' },
        { date: '2026-05-02', amount: -2000, cleared: false, payee: 'not ticked off' },
        { date: '2026-05-03', amount: 3000, cleared: false, payee: 'refund not ticked off' },
        { date: '2026-05-04', amount: -500, cleared: false, payee: 'also not ticked off' },
      ],
      bank: -2500,
      // Everything comes to -95.00 and the bank says -25.00, so 70.00 closes
      // it. The cleared rows alone are -100.00, which would have been 75.00.
      adjustment: 7000,
      uncleared: 3,
      clearedOnlyAdjustment: 7500,
    },
  ] as const;

  for (const c of CASES) {
    it(`${c.label}`, async () => {
      const budgetId = await budget(`cleared-${c.label.slice(0, 20)}`, [...c.rows]);

      const before = await balanceBreakdown(acct, TODAY);
      expect(before.unclearedCount, 'the fixture does not hold what it claims').toBe(c.uncleared);
      // The arithmetic the reply states, checked against the engine.
      expect(before.cleared + before.unclearedTotal).toBe(before.all);

      const text = (
        await reconcileCurrencyResidual({
          account: 'Card (USD)',
          target_balance: c.bank / 100,
          category: 'Cashback',
          date: TODAY,
        })
      ).join('\n');

      await api.loadBudget(budgetId);
      for (let i = 0; i < 6; i += 1) await api.getCategories();

      const written = (await rowsOn(TODAY)).find((r) => r.category === category);
      expect(written, 'no adjustment was booked').toBeDefined();
      expect(written!.amount, 'the adjustment was measured against the wrong figure').toBe(
        c.adjustment,
      );

      // The account now matches the bank counting every row, which is what the
      // tool has always promised and still does.
      const after = await balanceBreakdown(acct, TODAY);
      expect(after.all).toBe(c.bank);
      // The unmarked rows were not touched on the way past.
      expect(after.unclearedCount).toBe(c.uncleared);
      expect(after.unclearedTotal).toBe(before.unclearedTotal);

      // And the reply offers the other reading, when there is one to offer.
      if (c.uncleared === 0) {
        expect(text, 'said something about rows that do not exist').not.toMatch(/not marked cleared/);
      } else {
        expect(text).toMatch(
          new RegExp(`includes ${c.uncleared} rows? not marked cleared`),
        );
        expect(text).toContain('cleared rows alone come to');
        // Spelled out rather than left as arithmetic: this is the number that
        // says whether the figure given was measuring the other thing.
        expect(text).toContain(
          `the adjustment would have been ${formatMoney(c.clearedOnlyAdjustment)}`,
        );
      }
    }, 60_000);
  }

  it('counts an uncleared split once, not once per part', async () => {
    // The parent is what the balance counts, measured. Counting the children
    // as well would double the split and send an adjustment that size into the
    // residual category.
    const budgetId = await budget(
      'cleared-split',
      [{ date: '2026-05-01', amount: -10000, cleared: true, payee: 'drift' }],
      async () => {
        await api.addTransactions(
          acct,
          [
            {
              date: '2026-05-02',
              amount: -7000,
              cleared: false,
              payee_name: 'split in flight',
              subtransactions: [
                { amount: -3000, category },
                { amount: -4000, category },
              ],
            },
          ] as never,
          { learnCategories: false, runTransfers: false },
        );
      },
    );

    const before = await balanceBreakdown(acct, TODAY);
    expect(before.unclearedCount, 'the split was counted part by part').toBe(1);
    expect(before.unclearedTotal).toBe(-7000);
    expect(before.cleared).toBe(-10000);

    await reconcileCurrencyResidual({
      account: 'Card (USD)',
      target_balance: 0,
      category: 'Cashback',
      date: TODAY,
    });

    await api.loadBudget(budgetId);
    for (let i = 0; i < 6; i += 1) await api.getCategories();
    const after = await balanceBreakdown(acct, TODAY);
    expect(after.all).toBe(0);
    // And the split is still one row in the breakdown, not three.
    expect(after.unclearedCount).toBe(1);
    expect(after.unclearedTotal).toBe(-7000);
  }, 60_000);

  it('books nothing the second time, however many times it is run', async () => {
    // #97: the adjustment has to land inside the figure it was computed from,
    // or every run computes the same delta again. Checked with unmarked rows
    // in the account, since those are what this release changed around it.
    const budgetId = await budget('cleared-idempotent', [
      { date: '2026-05-01', amount: -10000, cleared: true, payee: 'drift' },
      { date: '2026-05-02', amount: -2000, cleared: false, payee: 'in flight' },
    ]);

    await reconcileCurrencyResidual({
      account: 'Card (USD)',
      target_balance: 0,
      category: 'Cashback',
      date: TODAY,
    });
    await api.loadBudget(budgetId);
    for (let i = 0; i < 6; i += 1) await api.getCategories();
    const afterFirst = (await api.getTransactions(acct, '1900-01-01', '2999-12-31')).length;

    const second = await reconcileCurrencyResidual({
      account: 'Card (USD)',
      target_balance: 0,
      category: 'Cashback',
      date: TODAY,
    });

    await api.loadBudget(budgetId);
    for (let i = 0; i < 6; i += 1) await api.getCategories();
    expect(
      (await api.getTransactions(acct, '1900-01-01', '2999-12-31')).length,
      'a second adjustment was booked',
    ).toBe(afterFirst);
    expect(second.join('\n')).toMatch(/No adjustment needed/);
  }, 60_000);

  it('writes the adjustment cleared', async () => {
    // Not load-bearing for the figure, which counts it either way, and kept
    // anyway: an adjustment that reconciles the account against a statement
    // is posted by definition, and leaving it unticked adds another row to
    // the pile this reports on. It is also what stops the next change here
    // from being a trap, since the cleared reading would not count it.
    const budgetId = await budget('cleared-flag', [
      { date: '2026-05-01', amount: -10000, cleared: true, payee: 'drift' },
    ]);

    await reconcileCurrencyResidual({
      account: 'Card (USD)',
      target_balance: 0,
      category: 'Cashback',
      date: TODAY,
    });

    await api.loadBudget(budgetId);
    for (let i = 0; i < 6; i += 1) await api.getCategories();
    const written = (await rowsOn(TODAY)).find((r) => r.category === category);
    expect(written!.cleared).toBe(true);
  }, 60_000);

  it('says what it left out, and what it would have booked instead', async () => {
    await budget('cleared-wording', [
      { date: '2026-05-01', amount: -10000, cleared: true, payee: 'drift' },
      { date: '2026-05-02', amount: -2000, cleared: false, payee: 'in flight' },
    ]);

    const text = (
      await reconcileCurrencyResidual({
        account: 'Card (USD)',
        target_balance: 0,
        category: 'Cashback',
        date: TODAY,
      })
    ).join('\n');

    // The figure used, what inside it is not marked cleared, the other
    // figure, and the other adjustment: everything needed to notice that the
    // balance given was measuring the other thing, without this deciding
    // which one it was.
    expect(text).toMatch(/Was: *-120\.00/);
    expect(text).toMatch(/includes 1 row not marked cleared, -20\.00/);
    expect(text).toMatch(/cleared rows alone come to -100\.00/);
    expect(text).toMatch(/would have been 100\.00/);
    expect(text).toMatch(/Check which of the two/);
  }, 60_000);

  it('says nothing about unmarked rows when there are none', async () => {
    // Ten accounts out of sixteen hold some; the other six should read exactly
    // as they did before this change.
    await budget('cleared-silent', [
      { date: '2026-05-01', amount: -10000, cleared: true, payee: 'drift' },
    ]);

    const text = (
      await reconcileCurrencyResidual({
        account: 'Card (USD)',
        target_balance: 0,
        category: 'Cashback',
        date: TODAY,
      })
    ).join('\n');

    expect(text).not.toMatch(/not marked cleared/);
    expect(text).toMatch(/Was: *-100\.00/);
  }, 60_000);
});

/**
 * The two axes together (#100 and #108).
 *
 * One is about *when* a row counts, the other about *whether* it counts, and
 * an account can hold both kinds at once. The preview is the one reply that
 * appears before anything is written, so it is where both have to be visible.
 */
describe.skipIf(skip)('an account holding rows ahead and rows not posted', () => {
  let acct = '';
  let budgetId = '';
  const ahead = (() => {
    const d = new Date();
    d.setDate(d.getDate() + 3);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  })();

  beforeAll(async () => {
    await initTestEngine();
    budgetId = await createFreshBudget(async () => {
      acct = await api.createAccount({ name: 'Card (USD)', type: 'credit' } as never, 0);
      const group = await api.createCategoryGroup({ name: 'G' } as never);
      await api.createCategory({ name: 'Cashback', group_id: group } as never);
      await api.addTransactions(
        acct,
        [
          { date: '2026-05-01', amount: -10000, cleared: true, payee_name: 'drift' },
          { date: '2026-05-02', amount: -2000, cleared: false, payee_name: 'in flight' },
          { date: ahead, amount: -4000, cleared: false, payee_name: 'POSTED-ALREADY' },
        ] as never,
        { learnCategories: false, runTransfers: false },
      );
    }, 'cleared-and-ahead');
    for (let i = 0; i < 6; i += 1) await api.getCategories();
  }, 60_000);

  afterAll(async () => {
    await shutdownTestEngine();
  });

  it('books nothing and shows both, so neither is a surprise afterwards', async () => {
    const text = (
      await reconcileCurrencyResidual({
        account: 'Card (USD)',
        target_balance: 0,
        category: 'Cashback',
        date: TODAY,
      })
    ).join('\n');

    expect(text).toMatch(/No adjustment was booked/);
    expect(text).toContain('POSTED-ALREADY');
    // The unmarked row is not one of the rows dated ahead, and the balance on
    // offer counts it, so the preview says what it is made of.
    expect(text).toMatch(/including: *1 row not marked cleared, -20\.00/);
    expect(text).toMatch(/cleared rows alone: *-100\.00/);

    await api.loadBudget(budgetId);
    const rows = await api.getTransactions(acct, '1900-01-01', '2999-12-31');
    expect(rows, 'something was written while asking a question').toHaveLength(3);
  }, 60_000);

  it('measures against every row up to today once the question is answered', async () => {
    const text = (
      await reconcileCurrencyResidual({
        account: 'Card (USD)',
        target_balance: 0,
        category: 'Cashback',
        date: TODAY,
        future_rows: 'exclude',
      })
    ).join('\n');

    // -100.00 cleared and -20.00 not marked, and the row dated ahead left out
    // because the caller said the bank has not posted it.
    expect(text).toMatch(/Was: *-120\.00/);

    await api.loadBudget(budgetId);
    for (let i = 0; i < 6; i += 1) await api.getCategories();
    const written = (
      (await api.getTransactions(acct, TODAY, TODAY)) as Array<Record<string, unknown>>
    ).find((r) => Number(r.amount) === 12000);
    expect(written, 'the adjustment did not close the gap it reported').toBeDefined();
  }, 60_000);

  it('leaves those lines out when every row is marked cleared', async () => {
    // Six of sixteen accounts hold nothing unmarked, and the preview on those
    // has to read exactly as it did before this change.
    let clean = '';
    const id = await createFreshBudget(async () => {
      clean = await api.createAccount({ name: 'Clean (USD)', type: 'credit' } as never, 0);
      const group = await api.createCategoryGroup({ name: 'G' } as never);
      await api.createCategory({ name: 'Cashback', group_id: group } as never);
      await api.addTransactions(
        clean,
        [
          { date: '2026-05-01', amount: -10000, cleared: true, payee_name: 'drift' },
          { date: ahead, amount: -4000, cleared: true, payee_name: 'POSTED-ALREADY' },
        ] as never,
        { learnCategories: false, runTransfers: false },
      );
    }, 'cleared-none-ahead');
    for (let i = 0; i < 6; i += 1) await api.getCategories();
    void id;

    const text = (
      await reconcileCurrencyResidual({
        account: 'Clean (USD)',
        target_balance: 0,
        category: 'Cashback',
        date: TODAY,
      })
    ).join('\n');

    expect(text).toMatch(/No adjustment was booked/);
    expect(text).not.toMatch(/not marked cleared/);
  }, 60_000);
});

/**
 * The breakdown has to describe the same rows as the figure above it
 * (#108, round 2).
 *
 * `breakdown` stops at today. Folding the rows dated ahead into the balance
 * without folding them into the breakdown left "cleared rows alone" naming a
 * figure that was the cleared total of nothing, and contradicting the preview
 * for the same account.
 */
describe.skipIf(skip)('the breakdown covers the same window as the figure', () => {
  let acct = '';
  const ahead = (() => {
    const d = new Date();
    d.setDate(d.getDate() + 3);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  })();
  const later = (() => {
    const d = new Date();
    d.setDate(d.getDate() + 10);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  })();

  beforeAll(async () => {
    await initTestEngine();
  }, 60_000);

  afterAll(async () => {
    await shutdownTestEngine();
  });

  // One budget per case: the first of these writes an adjustment, and a shared
  // fixture would leave the second measuring an account it had already moved.
  async function budget(name: string) {
    await createFreshBudget(async () => {
      acct = await api.createAccount({ name: 'Card (USD)', type: 'credit' } as never, 0);
      const group = await api.createCategoryGroup({ name: 'G' } as never);
      await api.createCategory({ name: 'Cashback', group_id: group } as never);
      await api.addTransactions(
        acct,
        [
          { date: '2026-05-01', amount: -10000, cleared: true, payee_name: 'marked' },
          { date: '2026-05-02', amount: -2000, cleared: false, payee_name: 'not marked' },
          // Dated ahead, one of each, so counting them changes both halves of
          // the breakdown and by different amounts.
          { date: ahead, amount: -900, cleared: false, payee_name: 'AHEAD-UNMARKED' },
          { date: later, amount: -100, cleared: true, payee_name: 'AHEAD-MARKED' },
        ] as never,
        { learnCategories: false, runTransfers: false },
      );
    }, name);
    for (let i = 0; i < 6; i += 1) await api.getCategories();
  }

  it('counts the rows ahead in the breakdown when it counts them in the balance', async () => {
    await budget('cleared-window-include');
    const text = (
      await reconcileCurrencyResidual({
        account: 'Card (USD)',
        target_balance: -50,
        category: 'Cashback',
        date: TODAY,
        future_rows: 'include',
      })
    ).join('\n');

    // -100.00 and -20.00 up to today, -9.00 and -1.00 ahead.
    expect(text).toMatch(/Was: *-130\.00/);
    // Two rows are not marked: the -20.00 and the -9.00.
    expect(text).toMatch(/includes 2 rows not marked cleared, -29\.00/);
    // Which leaves -101.00 marked, not -110.00.
    expect(text).toMatch(/cleared rows alone come to -101\.00/);
    expect(text).toMatch(/would have been 51\.00/);
  }, 60_000);

  it('leaves them out of both when the balance leaves them out', async () => {
    await budget('cleared-window-exclude');
    const text = (
      await reconcileCurrencyResidual({
        account: 'Card (USD)',
        target_balance: -50,
        category: 'Cashback',
        date: TODAY,
        future_rows: 'exclude',
      })
    ).join('\n');

    expect(text).toMatch(/Was: *-120\.00/);
    expect(text).toMatch(/includes 1 row not marked cleared, -20\.00/);
    expect(text).toMatch(/cleared rows alone come to -100\.00/);
  }, 60_000);
});

/**
 * What an account that already balances is told (#108, round 2).
 *
 * The alternative figure is there to check a balance against, not to book. An
 * assistant reading "the adjustment would have been -20.00" under a line
 * saying no adjustment is needed has every reason to go and book one.
 */
describe.skipIf(skip)('an account that already balances', () => {
  let acct = '';

  beforeAll(async () => {
    await initTestEngine();
  }, 60_000);

  afterAll(async () => {
    await shutdownTestEngine();
  });

  async function budget(name: string, rows: Array<{ amount: number; cleared: boolean }>) {
    await createFreshBudget(async () => {
      acct = await api.createAccount({ name: 'Card (USD)', type: 'credit' } as never, 0);
      const group = await api.createCategoryGroup({ name: 'G' } as never);
      await api.createCategory({ name: 'Cashback', group_id: group } as never);
      await api.addTransactions(
        acct,
        rows.map((r, i) => ({
          date: `2026-05-0${i + 1}`,
          amount: r.amount,
          cleared: r.cleared,
          payee_name: r.cleared ? 'marked' : 'not marked',
        })) as never,
        { learnCategories: false, runTransfers: false },
      );
    }, name);
    for (let i = 0; i < 6; i += 1) await api.getCategories();
  }

  it('does not hand it a number that reads as an adjustment to book', async () => {
    await budget('cleared-balanced', [
      { amount: -10000, cleared: true },
      { amount: -2000, cleared: false },
    ]);

    const text = (
      await reconcileCurrencyResidual({
        account: 'Card (USD)',
        target_balance: -120,
        category: 'Cashback',
        date: TODAY,
      })
    ).join('\n');

    expect(text).toMatch(/No adjustment needed/);
    expect(text).toMatch(/includes 1 row not marked cleared, -20\.00/);
    expect(text).toMatch(/not the balance you gave/);
    expect(text).toMatch(/Nothing was written/);
    expect(text, 'offered an adjustment under a line saying none is needed').not.toMatch(
      /adjustment would have been/,
    );
  }, 60_000);

  it('says both readings agree when the unmarked rows cancel out', async () => {
    // Derived from the figures rather than assumed: unmarked rows that sum to
    // zero leave the two readings identical, and saying one does not match
    // would be false.
    await budget('cleared-balanced-cancel', [
      { amount: -10000, cleared: true },
      { amount: -2000, cleared: false },
      { amount: 2000, cleared: false },
    ]);

    const text = (
      await reconcileCurrencyResidual({
        account: 'Card (USD)',
        target_balance: -100,
        category: 'Cashback',
        date: TODAY,
      })
    ).join('\n');

    expect(text).toMatch(/No adjustment needed/);
    expect(text).toMatch(/includes 2 rows not marked cleared, 0\.00/);
    expect(text).toMatch(/both readings agree/);
    expect(text).not.toMatch(/not the balance you gave/);
  }, 60_000);
});
