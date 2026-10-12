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
 * One payment, read off two statements (#161).
 *
 * 0.10.3 caught the case where the other side was already in the budget, on
 * the same date. Two ways the same payment still got recorded twice: the
 * other side arriving as an ordinary row in the same batch, because a card
 * statement calls it "PAYMENT RECEIVED" rather than naming an account; and
 * the two banks posting it a day apart, which is the ordinary case when they
 * are different banks.
 *
 * Everything here is read back once the write has settled, because a batch
 * that reports refusal while having written something is the failure this
 * design exists to prevent.
 */
describe.skipIf(skip)('a payment that arrives from both sides', () => {
  let bank = '';
  let card = '';

  beforeAll(async () => {
    await initTestEngine();
  }, 60_000);

  afterAll(async () => {
    await shutdownTestEngine();
  });

  async function budget(name: string, seed?: () => Promise<void>) {
    await createFreshBudget(async () => {
      bank = await api.createAccount({ name: 'Bank', offbudget: false } as never, 0);
      card = await api.createAccount({ name: 'Card', offbudget: false } as never, 0);
      if (seed) await seed();
    }, name);
    for (let i = 0; i < 6; i += 1) await api.getCategories();
  }

  const count = async (acct: string) =>
    (await api.getTransactions(acct, '1900-01-01', '2999-12-31')).length;

  /** The pair as the two statements give it: a transfer and an ordinary row. */
  const bothSides = (transferDate: string, ordinaryDate: string) => [
    { account: 'Bank', amount: -800, payee: 'Card', date: transferDate },
    { account: 'Card', amount: 800, payee: 'PAYMENT RECEIVED', date: ordinaryDate },
  ];

  describe('both sides in the same batch', () => {
    const CASES = [
      { label: 'the same day', transfer: '2026-09-25', ordinary: '2026-09-25', refused: true },
      { label: 'the card a day later', transfer: '2026-09-25', ordinary: '2026-09-26', refused: true },
      { label: 'the card a day earlier', transfer: '2026-09-25', ordinary: '2026-09-24', refused: true },
      { label: 'two days apart', transfer: '2026-09-25', ordinary: '2026-09-27', refused: false },
    ] as const;

    for (const c of CASES) {
      it(`${c.label}: ${c.refused ? 'refused as one movement' : 'written as two'}`, async () => {
        await budget(`batch-pair-${c.label.replace(/\W+/g, '-')}`);
        const beforeBank = await count(bank);
        const beforeCard = await count(card);

        const lines = await createTransactions({
          transactions: bothSides(c.transfer, c.ordinary),
        });
        for (let i = 0; i < 6; i += 1) await api.getCategories();

        if (c.refused) {
          expect(await count(bank), 'something was written').toBe(beforeBank);
          expect(await count(card), 'something was written').toBe(beforeCard);
          const text = lines.join('\n');
          expect(text).toContain('Nothing was created');
          expect(text).toContain('is the other side of the transfer in row 1');
          // The dates, both of them, since that is what someone has to check.
          expect(text).toContain(c.transfer);
          expect(text).toContain(c.ordinary);
        } else {
          // Two days apart is far enough to be two movements. The transfer
          // writes both its sides, so the card gains two rows.
          expect(await count(bank)).toBe(beforeBank + 1);
          expect(await count(card)).toBe(beforeCard + 2);
        }
      }, 60_000);
    }

    it('writes both when they really are two movements', async () => {
      // The way out has to work, or the check is a wall.
      await budget('batch-pair-allowed');
      const beforeCard = await count(card);

      await createTransactions({
        transactions: bothSides('2026-09-25', '2026-09-26'),
        allow_duplicate: true,
      });
      for (let i = 0; i < 6; i += 1) await api.getCategories();

      expect(await count(card)).toBe(beforeCard + 2);
    }, 60_000);

    it('refuses the ordinary row, not the transfer', async () => {
      // The transfer writes both sides, so it is the row that can stay. A
      // refusal pointed at the transfer would have the person delete the one
      // that does the work.
      await budget('batch-pair-which-row');

      const lines = await createTransactions({ transactions: bothSides('2026-09-25', '2026-09-26') });
      const text = lines.join('\n');

      expect(text).toContain('row 2  Card');
      expect(text, 'the transfer was the one refused').not.toContain('row 1  Bank');
    }, 60_000);

    it('leaves an ordinary row in a third account alone', async () => {
      // Same amount, same window, wrong account: a credit on another account
      // that week is not the other side of this transfer.
      await budget('batch-pair-other-account', async () => {
        await api.createAccount({ name: 'Savings', offbudget: false } as never, 0);
      });
      const savings = (await api.getAccounts()).find((a) => a.name === 'Savings')!.id;
      const beforeSavings = await count(savings);

      await createTransactions({
        transactions: [
          { account: 'Bank', amount: -800, payee: 'Card', date: '2026-09-25' },
          { account: 'Savings', amount: 800, payee: 'Something else', date: '2026-09-26' },
        ],
      });
      for (let i = 0; i < 6; i += 1) await api.getCategories();

      expect(await count(savings), 'a row in another account was caught').toBe(beforeSavings + 1);
    }, 60_000);

    it('leaves an ordinary row that is not the other side alone', async () => {
      // Same account, same window, different amount: an unrelated purchase on
      // the card that week must not be caught.
      await budget('batch-pair-unrelated');
      const beforeCard = await count(card);

      await createTransactions({
        transactions: [
          { account: 'Bank', amount: -800, payee: 'Card', date: '2026-09-25' },
          { account: 'Card', amount: -45.5, payee: 'Supermarket', date: '2026-09-26' },
        ],
      });
      for (let i = 0; i < 6; i += 1) await api.getCategories();

      // The transfer's own leg plus the purchase.
      expect(await count(card)).toBe(beforeCard + 2);
    }, 60_000);
  });

  describe('the other side already in the budget', () => {
    const CASES = [
      { label: 'the same day', imported: '2026-09-25', transfer: '2026-09-25', refused: true },
      { label: 'a day earlier', imported: '2026-09-24', transfer: '2026-09-25', refused: true },
      { label: 'a day later', imported: '2026-09-26', transfer: '2026-09-25', refused: true },
      { label: 'two days later', imported: '2026-09-27', transfer: '2026-09-25', refused: false },
      { label: 'two days earlier', imported: '2026-09-23', transfer: '2026-09-25', refused: false },
    ] as const;

    for (const c of CASES) {
      it(`${c.label}: ${c.refused ? 'refused' : 'written'}`, async () => {
        await budget(`batch-imported-${c.label.replace(/\W+/g, '-')}`, async () => {
          // Already imported from the card's own statement.
          await api.addTransactions(
            await api.getAccounts().then((a) => a.find((x) => x.name === 'Card')!.id),
            [{ date: c.imported, amount: 80000, payee_name: 'PAYMENT RECEIVED' }] as never,
            { learnCategories: false, runTransfers: false },
          );
        });
        const beforeCard = await count(card);

        const lines = await createTransactions({
          transactions: [{ account: 'Bank', amount: -800, payee: 'Card', date: c.transfer }],
        });
        for (let i = 0; i < 6; i += 1) await api.getCategories();

        if (c.refused) {
          expect(await count(card), 'the money arrived twice').toBe(beforeCard);
          const text = lines.join('\n');
          expect(text).toContain('Nothing was created');
          expect(text).toContain('not part of a transfer');
          expect(text).toContain(c.imported);
          expect(text).toContain(c.transfer);
        } else {
          expect(await count(card)).toBe(beforeCard + 1);
        }
      }, 60_000);
    }
  });

  it('leaves two real payments of the same amount on consecutive days alone', async () => {
    // What the window could have cost, measured rather than assumed: two card
    // payments of the same size in one week is ordinary, and they go through.
    // The window only compares a row against the *other* account, so two
    // movements from the same account on different days never meet it, and
    // the same-account check still compares the exact date.
    await budget('batch-two-real-payments');
    const beforeBank = await count(bank);

    await createTransactions({
      transactions: [
        { account: 'Bank', amount: -800, payee: 'Card', date: '2026-09-25' },
        { account: 'Bank', amount: -800, payee: 'Card', date: '2026-09-26' },
      ],
    });
    for (let i = 0; i < 6; i += 1) await api.getCategories();

    expect(await count(bank), 'a real pair was refused').toBe(beforeBank + 2);
  }, 60_000);

  it('takes a second payment the day after one already in the budget', async () => {
    // The same-account check still compares the exact date, and it has to: a
    // card paid twice in a week, the first already recorded, is ordinary. The
    // window is only for the other side of one movement, in the other
    // account.
    await budget('batch-second-payment-next-day', async () => {
      const accounts = await api.getAccounts();
      await api.addTransactions(
        accounts.find((a) => a.name === 'Bank')!.id,
        [{ date: '2026-09-25', amount: -80000, payee_name: 'Card payment' }] as never,
        { learnCategories: false, runTransfers: false },
      );
    });
    const beforeBank = await count(bank);

    await createTransactions({
      transactions: [{ account: 'Bank', amount: -800, payee: 'Groceries', date: '2026-09-26' }],
    });
    for (let i = 0; i < 6; i += 1) await api.getCategories();

    expect(await count(bank), 'a second payment the next day was refused').toBe(beforeBank + 1);
  }, 60_000);

  it('still refuses the same payment sent twice on the same day', async () => {
    // And the check it does have is unchanged: same account, same date, same
    // amount is still one movement written twice, with allow_duplicate as the
    // way out.
    await budget('batch-same-day-twice');
    const beforeBank = await count(bank);

    const twice = [
      { account: 'Bank', amount: -800, payee: 'Card', date: '2026-09-25' },
      { account: 'Bank', amount: -800, payee: 'Card', date: '2026-09-25' },
    ];
    const refused = await createTransactions({ transactions: twice });

    expect(await count(bank)).toBe(beforeBank);
    expect(refused.join('\n')).toContain('Nothing was created');

    await createTransactions({ transactions: twice, allow_duplicate: true });
    for (let i = 0; i < 6; i += 1) await api.getCategories();
    expect(await count(bank), 'the way out did not work').toBe(beforeBank + 2);
  }, 60_000);
});
