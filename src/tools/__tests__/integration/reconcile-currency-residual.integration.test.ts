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

const skip = process.env.SKIP_ACTUAL_INTEGRATION === '1';

function plusDays(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(
    d.getDate(),
  ).padStart(2, '0')}`;
}

// Read once. Calling plusDays() again inside an assertion would disagree with
// the fixture across a midnight boundary.
const AHEAD = plusDays(3);
const LATER = plusDays(30);

describe.skipIf(skip)('reconcile_currency_residual integration (#30)', () => {
  beforeAll(async () => {
    await initTestEngine();
  }, 60_000);

  afterAll(async () => {
    await shutdownTestEngine();
  });

  it('books an adjustment in the given category that brings the account to target', async () => {
    let acctId = '';
    let cashbackId = '';
    const budgetId = await createFreshBudget(async () => {
      acctId = await api.createAccount({ name: 'Card (USD)', type: 'credit' } as any, 0);
      const g = await api.createCategoryGroup({ name: 'G' } as any);
      cashbackId = await api.createCategory({ name: 'Cashback', group_id: g } as any);
      // Accumulated FX residual: account sits at -100.00 while the bank says 0.
      await api.addTransactions(
        acctId,
        [{ date: '2026-05-01', amount: -10000, payee_name: 'FX drift' }] as any,
        { learnCategories: false, runTransfers: false },
      );
    });

    const before = await api.getAccountBalance(acctId);
    expect(before).toBe(-10000);

    await reconcileCurrencyResidual({
      account: 'Card (USD)',
      target_balance: 0,
      category: 'Cashback',
      date: '2026-06-05',
    });

    await api.loadBudget(budgetId);
    const after = await api.getAccountBalance(acctId);
    expect(after).toBe(0);

    // The adjustment must be the +100.00 transaction booked under Cashback.
    const adjustments = await api.getTransactions(acctId, '2026-06-05', '2026-06-05');
    const adjustment = adjustments.find((t: any) => t.amount === 10000);
    expect(adjustment, 'adjustment transaction should exist').toBeTruthy();
    expect((adjustment as any).category).toBe(cashbackId);
  }, 60_000);

  /**
   * Fixture shared by the collision cases: -200 of drift against +100 of
   * unrelated refund leaves the account at -100, so the adjustment is +100,
   * exactly the refund's amount on exactly the refund's day.
   */
  async function budgetWithACollision(name: string) {
    let acctId = '';
    const budgetId = await createFreshBudget(async () => {
      acctId = await api.createAccount({ name, type: 'credit' } as any, 0);
      const g = await api.createCategoryGroup({ name: `G-${name}` } as any);
      await api.createCategory({ name: `Cash-${name}`, group_id: g } as any);
      await api.addTransactions(
        acctId,
        [
          { date: '2026-05-01', amount: -20000, payee_name: 'FX drift' },
          { date: '2026-06-05', amount: 10000, payee_name: 'Unrelated refund' },
        ] as any,
        { learnCategories: false, runTransfers: false },
      );
    });
    return { acctId, budgetId, category: `Cash-${name}` };
  }

  it('does not announce a reconciliation it did not perform', async () => {
    // The whole of the original defect: the header printed regardless, so the
    // reply stated the adjustment, then stated that nothing had been created,
    // then advised a flag the tool did not accept, with the balance unchanged.
    const { acctId, budgetId, category } = await budgetWithACollision('Card (EUR)');

    const text = (
      await reconcileCurrencyResidual({
        account: 'Card (EUR)',
        target_balance: 0,
        category,
        date: '2026-06-05',
      })
    ).join('\n');

    expect(text).not.toMatch(/Currency residual reconciled/);
    expect(text).toMatch(/No adjustment was booked/);
    expect(text).toMatch(/allow_duplicate/);

    await api.loadBudget(budgetId);
    // Refused means refused: the balance is untouched and no third row exists.
    expect(await api.getAccountBalance(acctId)).toBe(-10000);
    expect((await api.getTransactions(acctId, '2026-06-05', '2026-06-05')).length).toBe(1);
  }, 60_000);

  it('books the adjustment when the caller says the match is not it', async () => {
    const { acctId, budgetId, category } = await budgetWithACollision('Card (GBP)');

    const text = (
      await reconcileCurrencyResidual({
        account: 'Card (GBP)',
        target_balance: 0,
        category,
        date: '2026-06-05',
        allow_duplicate: true,
      })
    ).join('\n');

    expect(text).toMatch(/Currency residual reconciled/);

    await api.loadBudget(budgetId);
    expect(await api.getAccountBalance(acctId)).toBe(0);
    expect((await api.getTransactions(acctId, '2026-06-05', '2026-06-05')).length).toBe(2);
  }, 60_000);

  it('refuses a future date rather than booking something that cannot reconcile', async () => {
    // Measured, both ways round, before this became a refusal: the balance
    // counts `date <= today`, so an adjustment dated ahead never entered it.
    // Two runs at the same future date wrote two adjustments; and moving the
    // cutoff to the adjustment's own date instead made `Was:` disagree with
    // the bank statement and still left a second run with no date free to book
    // again.
    let acctId = '';
    await createFreshBudget(async () => {
      acctId = await api.createAccount({ name: 'Card (CHF)', type: 'credit' } as any, 0);
      const g = await api.createCategoryGroup({ name: 'G-CHF' } as any);
      await api.createCategory({ name: 'Cash-CHF', group_id: g } as any);
      await api.addTransactions(
        acctId,
        [{ date: '2026-05-01', amount: -10000, payee_name: 'FX drift' }] as any,
        { learnCategories: false, runTransfers: false },
      );
    });

    await expect(
      reconcileCurrencyResidual({
        account: 'Card (CHF)',
        target_balance: 0,
        category: 'Cash-CHF',
        // Far enough ahead that the test does not become a time bomb: dated
        // 2027, it would have started failing on 6 June 2027.
        date: '2099-06-05',
      }),
    ).rejects.toThrow(/2099-06-05.*after this server's today/s);

    // Refused means nothing written.
    expect(await api.getTransactions(acctId, '1900-01-01', '2099-12-31')).toHaveLength(1);
  }, 60_000);

  it('measures the balance at today, not at the adjustment date', async () => {
    // What this pins is the cutoff, and only the cutoff. An earlier attempt
    // measured the balance as of the date being written, which silently
    // excluded everything between that date and today.
    //
    // Every row here is in the past on purpose. Whether a row dated *after*
    // today should count towards the balance is an open question, not a
    // settled one: a card purchase made at the weekend is commonly posted by
    // the bank with a later date, so the bank has already deducted something
    // that Actual has not yet counted. That is #100, and this test must not
    // decide it by accident. It used to: it seeded a row dated 2099 and
    // asserted that ignoring it was correct, which would have had to be
    // rewritten to fix #100, and a test you must change to fix a bug is a test
    // that asserts the bug.
    let acctId = '';
    await createFreshBudget(async () => {
      acctId = await api.createAccount({ name: 'Card (NOK)', type: 'credit' } as any, 0);
      const g = await api.createCategoryGroup({ name: 'G-NOK' } as any);
      await api.createCategory({ name: 'Cash-NOK', group_id: g } as any);
      await api.addTransactions(
        acctId,
        [
          { date: '2026-05-01', amount: -10000, payee_name: 'FX drift' },
          // Later than the adjustment's date, earlier than today: counted if
          // the cutoff is today, invisible if it follows the adjustment.
          { date: '2026-06-10', amount: -5000, payee_name: 'After the booking date' },
        ] as any,
        { learnCategories: false, runTransfers: false },
      );
    });

    const text = (
      await reconcileCurrencyResidual({
        account: 'Card (NOK)',
        target_balance: 0,
        category: 'Cash-NOK',
        date: '2026-06-01',
      })
    ).join('\n');

    expect(text).toContain('Was:        -150.00');
    expect(text).toContain('Adjustment: 150.00');
    expect(await api.getAccountBalance(acctId)).toBe(0);
  }, 60_000);

  it('stops by itself on a second run at the same date', async () => {
    // The guarantee that replaced the cutoff: once the adjustment is in, the
    // balance equals the target and the second run never reaches the write.
    let acctId = '';
    await createFreshBudget(async () => {
      acctId = await api.createAccount({ name: 'Card (SEK)', type: 'credit' } as any, 0);
      const g = await api.createCategoryGroup({ name: 'G-SEK' } as any);
      await api.createCategory({ name: 'Cash-SEK', group_id: g } as any);
      await api.addTransactions(
        acctId,
        [{ date: '2026-05-01', amount: -10000, payee_name: 'FX drift' }] as any,
        { learnCategories: false, runTransfers: false },
      );
    });

    const args = { account: 'Card (SEK)', target_balance: 0, category: 'Cash-SEK' };
    await reconcileCurrencyResidual(args);
    const second = (await reconcileCurrencyResidual(args)).join('\n');

    expect(second).toMatch(/No adjustment needed/);
    const all = await api.getTransactions(acctId, '1900-01-01', '2099-12-31');
    expect(all.filter((t: any) => t.amount === 10000)).toHaveLength(1);
  }, 60_000);

  it('waits for the pull to finish before reading the balance', async () => {
    // Reconcile computes what it writes from the balance, so a stale balance
    // is a wrong adjustment, not merely a missed warning.
    //
    // Start AND finish, not just which call came first. A promise started and
    // not awaited still gets its call in first, so `void pullBeforeReading()`
    // satisfied an order-of-start check while the balance was read against the
    // copy the pull was meant to refresh. That is the same hole this round
    // closed in the util and then reproduced here.
    const { category } = await budgetWithACollision('Card (JPY)');

    const order: string[] = [];
    vi.mocked(api.sync).mockClear().mockImplementation(async () => {
      order.push('sync:start');
      await Promise.resolve();
      await Promise.resolve();
      order.push('sync:done');
    });
    const balanceSpy = vi.spyOn(api, 'getAccountBalance').mockImplementation(async () => {
      order.push('balance');
      return -10000;
    });

    await reconcileCurrencyResidual({
      account: 'Card (JPY)',
      target_balance: 0,
      category,
      date: '2026-06-07',
    });

    balanceSpy.mockRestore();
    expect(order.slice(0, 3)).toEqual(['sync:start', 'sync:done', 'balance']);
  }, 60_000);

  /**
   * #100. The scenario that motivated it, measured before anything was
   * changed: an account at -100.00 to today, a -40.00 purchase dated ahead
   * that the bank has already posted, a -80.00 transfer scheduled for later
   * that it has not, and a bank figure of -140.00. It booked -40.00 and left
   * the account summing to -260.00 where the bank ends at -220.00. The
   * adjustment was exactly the purchase, recorded a second time, in a category
   * that says it is currency drift.
   */
  describe('transactions dated after today', () => {
    async function budgetWithFutureRows(name: string) {
      let acctId = '';
      const budget = await createFreshBudget(async () => {
        acctId = await api.createAccount({ name, type: 'credit' } as never, 0);
        const group = await api.createCategoryGroup({ name: `G-${name}` } as never);
        await api.createCategory({ name: `C-${name}`, group_id: group } as never);
        await api.addTransactions(
          acctId,
          [
            { date: '2026-05-01', amount: -10000, payee_name: 'FX drift' },
            { date: AHEAD, amount: -4000, payee_name: 'WEEKEND-PURCHASE' },
            { date: LATER, amount: -8000, payee_name: 'SCHEDULED-LATER' },
          ] as never,
          { learnCategories: false, runTransfers: false },
        );
      });
      return { acctId, budget, category: `C-${name}` };
    }

    it('books nothing, and shows both readings, when it cannot know which they are', async () => {
      const { acctId, budget, category } = await budgetWithFutureRows('Card (A)');

      const text = (
        await reconcileCurrencyResidual({
          account: 'Card (A)',
          target_balance: -140,
          category,
        })
      ).join('\n');

      expect(text).toMatch(/No adjustment was booked/);
      expect(text).toContain('WEEKEND-PURCHASE');
      expect(text).toContain('SCHEDULED-LATER');
      expect(text).toContain('Balance to today:        -100.00');
      expect(text).toContain('Balance counting them:   -220.00');

      await api.loadBudget(budget);
      const rows = await api.getTransactions(acctId, '1900-01-01', '2099-12-31');
      expect(rows, 'nothing was written').toHaveLength(3);
    }, 60_000);

    it('counts them in when the bank has posted them, which is the motivating case', async () => {
      const { acctId, budget, category } = await budgetWithFutureRows('Card (B)');

      const text = (
        await reconcileCurrencyResidual({
          account: 'Card (B)',
          target_balance: -220,
          category,
          future_rows: 'include',
        })
      ).join('\n');

      // Nothing to do, and that is the whole point. The account already
      // agrees with the bank once the rows dated ahead are counted, so no
      // adjustment is booked. Told to exclude them, the same call books -40.00
      // and duplicates the purchase, which is what the test below shows.
      expect(text).toMatch(/No adjustment needed/);
      expect(text).toContain('-220.00');

      await api.loadBudget(budget);
      expect(await api.getTransactions(acctId, '1900-01-01', '2099-12-31')).toHaveLength(3);
    }, 60_000);

    it('still books a real residual when one survives counting them in', async () => {
      // Proves the arithmetic rather than only the refusal: -230.00 reported
      // against -220.00 counted is a genuine -10.00 of drift.
      const { acctId, budget, category } = await budgetWithFutureRows('Card (E)');

      const text = (
        await reconcileCurrencyResidual({
          account: 'Card (E)',
          target_balance: -230,
          category,
          future_rows: 'include',
        })
      ).join('\n');

      expect(text).toMatch(/Currency residual reconciled/);
      expect(text).toMatch(/Was:        -220\.00/);
      expect(text).toMatch(/Adjustment: -10\.00/);

      await api.loadBudget(budget);
      expect(await api.getTransactions(acctId, '1900-01-01', '2099-12-31')).toHaveLength(4);
    }, 60_000);

    it('leaves them out when the bank has not, which is the older behaviour', async () => {
      const { acctId, budget, category } = await budgetWithFutureRows('Card (C)');

      const text = (
        await reconcileCurrencyResidual({
          account: 'Card (C)',
          target_balance: -140,
          category,
          future_rows: 'exclude',
        })
      ).join('\n');

      expect(text).toMatch(/Was:        -100\.00/);
      expect(text).toMatch(/Adjustment: -40\.00/);

      await api.loadBudget(budget);
      expect(await api.getTransactions(acctId, '1900-01-01', '2099-12-31')).toHaveLength(4);
    }, 60_000);

    it('lists a split dated ahead as the purchase, not as its parts', async () => {
      // Measured while choosing the query: `inline` substitutes a split's
      // parts for the parent and would list three rows where there are two
      // purchases. Both total the same, so only the listing tells them apart.
      let acctId = '';
      await createFreshBudget(async () => {
        acctId = await api.createAccount({ name: 'Card (F)', type: 'credit' } as never, 0);
        const group = await api.createCategoryGroup({ name: 'G-F' } as never);
        const category = await api.createCategory({ name: 'C-F', group_id: group } as never);
        await api.addTransactions(
          acctId,
          [
            { date: '2026-05-01', amount: -10000, payee_name: 'FX drift' },
            {
              date: AHEAD,
              amount: -6000,
              payee_name: 'SPLIT-AHEAD',
              subtransactions: [
                { amount: -2000, category },
                { amount: -4000, category },
              ],
            },
          ] as never,
          { learnCategories: false, runTransfers: false },
        );
      });

      const text = (
        await reconcileCurrencyResidual({
          account: 'Card (F)',
          target_balance: -160,
          category: 'C-F',
        })
      ).join('\n');

      // No `not.toContain('-20.00')` under these: for a part's amount to
      // appear there would have to be a second row, which fails the count
      // above, or the single row would have to be a part, which fails the
      // -60.00 below. It could never be the assertion that reports, which is
      // the same reason two of its kind came out of `future-dated.test.ts`.
      expect(text).toMatch(/holds one transaction dated after today/);
      expect(text).toContain('-60.00');
      expect(text).toContain('Those rows come to:      -60.00');
    }, 60_000);

    it('labels rows by what the engine actually records about them', async () => {
      // The joint between the lookup and the text, which neither end covered:
      // one test mocks the query and the other hands rows in by hand, so the
      // fields the engine really sets were never exercised. Four rows, one per
      // outcome, in one preview.
      let acctId = '';
      let savings = '';
      await createFreshBudget(async () => {
        acctId = await api.createAccount({ name: 'Card (I)', type: 'credit' } as never, 0);
        savings = await api.createAccount({ name: 'Savings (I)', type: 'savings' } as never, 0);
        const group = await api.createCategoryGroup({ name: 'G-I' } as never);
        await api.createCategory({ name: 'C-I', group_id: group } as never);
        await api.addTransactions(
          acctId,
          [{ date: '2026-05-01', amount: -10000, payee_name: 'FX drift' }] as never,
          { learnCategories: false, runTransfers: false },
        );
      });

      // Arrived from the bank.
      await api.importTransactions(acctId, [
        { date: AHEAD, amount: -1500, payee_name: 'FROM-THE-BANK', imported_id: 'bank-1', cleared: true },
      ] as never);
      // Typed here, not reconciled.
      await api.addTransactions(
        acctId,
        [{ date: AHEAD, amount: -2500, payee_name: 'TYPED-HERE', cleared: false }] as never,
        { learnCategories: false, runTransfers: false },
      );
      // Reconciled here but never imported: neither label is true of it.
      await api.addTransactions(
        acctId,
        [{ date: AHEAD, amount: -3500, payee_name: 'CLEARED-HERE', cleared: true }] as never,
        { learnCategories: false, runTransfers: false },
      );
      // One leg of a real transfer, which the previous labelling called "not a
      // bank movement" and which the engine returns cleared.
      const payees = await api.getPayees();
      const toSavings = payees.find((p) => p.transfer_acct === savings)!;
      await api.addTransactions(
        acctId,
        [{ date: LATER, amount: -5000, payee: toSavings.id }] as never,
        { learnCategories: false, runTransfers: true },
      );

      const lines = await reconcileCurrencyResidual({
        account: 'Card (I)',
        target_balance: -140,
        category: 'C-I',
      });
      const lineWith = (needle: string) => {
        const found = lines.filter((l) => l.includes(needle));
        expect(found, `expected one line for ${needle}`).toHaveLength(1);
        return found[0];
      };

      // `From-The-Bank`, not `FROM-THE-BANK`: `importTransactions` title-cases
      // the payee on the way in, which is worth knowing before matching on one.
      expect(lineWith('From-The-Bank')).toContain('came from the bank');
      expect(lineWith('TYPED-HERE')).toContain('entered here, not reconciled');
      expect(lineWith('CLEARED-HERE')).not.toMatch(/came from the bank|entered here/);
      expect(lineWith('Savings (I)')).not.toMatch(/came from the bank|entered here/);
    }, 60_000);

    it('lists them oldest first, so the nearest one is read first', async () => {
      const { category } = await budgetWithFutureRows('Card (G)');

      const text = (
        await reconcileCurrencyResidual({
          account: 'Card (G)',
          target_balance: -140,
          category,
        })
      ).join('\n');

      expect(text.indexOf('WEEKEND-PURCHASE')).toBeLessThan(text.indexOf('SCHEDULED-LATER'));
    }, 60_000);

    it('treats a row dated exactly today as present, not as ahead', async () => {
      // The boundary the `$gt` sits on. A row dated today is already in the
      // balance, so asking about it would be asking about nothing.
      let acctId = '';
      await createFreshBudget(async () => {
        acctId = await api.createAccount({ name: 'Card (H)', type: 'credit' } as never, 0);
        const group = await api.createCategoryGroup({ name: 'G-H' } as never);
        await api.createCategory({ name: 'C-H', group_id: group } as never);
        await api.addTransactions(
          acctId,
          [
            { date: '2026-05-01', amount: -10000, payee_name: 'FX drift' },
            { date: plusDays(0), amount: -2500, payee_name: 'TODAY-ROW' },
          ] as never,
          { learnCategories: false, runTransfers: false },
        );
      });

      const text = (
        await reconcileCurrencyResidual({
          account: 'Card (H)',
          target_balance: 0,
          category: 'C-H',
        })
      ).join('\n');

      expect(text).toMatch(/Currency residual reconciled/);
      expect(text).not.toMatch(/dated after today/);
      // -100 drift and -25 today are both counted, so the adjustment closes both.
      expect(text).toMatch(/Was:        -125\.00/);
    }, 60_000);

    it('does not ask the question of an account with nothing dated ahead', async () => {
      // The check must cost nothing in the ordinary case, or every
      // reconciliation grows a step.
      const { category } = await budgetWithACollision('Card (D)');

      const text = (
        await reconcileCurrencyResidual({
          account: 'Card (D)',
          target_balance: 0,
          category,
          date: '2026-06-07',
        })
      ).join('\n');

      expect(text).toMatch(/Currency residual reconciled/);
      expect(text).not.toMatch(/dated after today/);
    }, 60_000);
  });
});
