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

  describe('across a daylight saving change', () => {
    // The window was counted in hours, and the day a clock goes back is 25 of
    // them, so two consecutive dates stopped being within one day and the
    // pair was written twice. Measured with TZ=America/New_York on 1 and 2
    // November: "Created 2 transactions" and the card holding the money
    // twice, while the same batch in a zone without daylight saving refused
    // it.
    const realTZ = process.env.TZ;

    afterAll(() => {
      if (realTZ === undefined) delete process.env.TZ;
      else process.env.TZ = realTZ;
    });

    for (const [zone, label] of [
      ['America/New_York', 'a zone that changes its clocks'],
      ['America/Santo_Domingo', 'a zone that does not'],
      ['UTC', 'UTC'],
    ] as const) {
      it(`refuses the pair in ${label}`, async () => {
        process.env.TZ = zone;
        await budget(`batch-dst-${zone.replace(/\W+/g, '-')}`);
        const beforeCard = await count(card);

        const lines = await createTransactions({
          transactions: [
            { account: 'Bank', amount: -800, payee: 'Card', date: '2026-11-01' },
            { account: 'Card', amount: 800, payee: 'PAYMENT RECEIVED', date: '2026-11-02' },
          ],
        });
        for (let i = 0; i < 6; i += 1) await api.getCategories();

        expect(await count(card), `written in ${zone}`).toBe(beforeCard);
        expect(lines.join('\n')).toContain('is the other side of the transfer');
      }, 60_000);
    }

    it('still lets two days apart through on a clock-change day', async () => {
      process.env.TZ = 'America/New_York';
      await budget('batch-dst-two-days');
      const beforeCard = await count(card);

      await createTransactions({
        transactions: [
          { account: 'Bank', amount: -800, payee: 'Card', date: '2026-11-01' },
          { account: 'Card', amount: 800, payee: 'PAYMENT RECEIVED', date: '2026-11-03' },
        ],
      });
      for (let i = 0; i < 6; i += 1) await api.getCategories();

      // The transfer's own leg plus the ordinary row.
      expect(await count(card)).toBe(beforeCard + 2);
    }, 60_000);
  });

  describe('one transfer accounts for one row', () => {
    it('does not refuse two credits for one transfer', async () => {
      // A transfer writes one counterpart, so it can only explain one row.
      // Matching each ordinary row against the first transfer that fits
      // rejected a refund that had nothing to do with the payment.
      await budget('batch-one-to-one');
      const beforeCard = await count(card);

      const lines = await createTransactions({
        transactions: [
          { account: 'Bank', amount: -800, payee: 'Card', date: '2026-09-25' },
          { account: 'Card', amount: 800, payee: 'PAYMENT RECEIVED', date: '2026-09-24' },
          { account: 'Card', amount: 800, payee: 'Refund shop', date: '2026-09-26' },
        ],
      });
      const text = lines.join('\n');

      // Nothing is written, since the batch is all or nothing, but only one
      // row is named as the other side.
      expect(await count(card)).toBe(beforeCard);
      expect(text.match(/is the other side of the transfer/g)).toHaveLength(1);
      expect(text).toContain('row 2  Card');
      expect(text, 'the refund was refused as well').not.toContain('row 3  Card');
    }, 60_000);

    it('pairs by date even when that is not the order they were sent in', async () => {
      // The transfers arrive in the opposite order to their twins. Taking the
      // first transfer that fits pairs row 3 with row 1, two days from its
      // own date, while the row dated the same day sits in row 2.
      await budget('batch-one-to-one-crossed');

      const lines = await createTransactions({
        transactions: [
          { account: 'Bank', amount: -800, payee: 'Card', date: '2026-09-26' },
          { account: 'Bank', amount: -800, payee: 'Card', date: '2026-09-25' },
          { account: 'Card', amount: 800, payee: 'PAYMENT ONE', date: '2026-09-25' },
          { account: 'Card', amount: 800, payee: 'PAYMENT TWO', date: '2026-09-26' },
        ],
      });
      const rows = lines.join('\n').split('\n');

      const third = rows.findIndex((l) => l.includes('row 3  Card'));
      const fourth = rows.findIndex((l) => l.includes('row 4  Card'));
      // Row 3 is dated the 25th, which is row 2's date.
      expect(rows[third + 1]).toContain('transfer in row 2');
      expect(rows[fourth + 1]).toContain('transfer in row 1');
    }, 60_000);

    it('does not spend a transfer on a row that has another one', async () => {
      // Row 3 fits both transfers; row 5 fits only the second. Letting one
      // row be paired twice consumes that second transfer and leaves row 5
      // unreported, which is the money going in twice with nothing said.
      await budget('batch-one-to-one-greedy');

      const lines = await createTransactions({
        transactions: [
          { account: 'Bank', amount: -800, payee: 'Card', date: '2026-09-25' },
          { account: 'Bank', amount: -800, payee: 'Card', date: '2026-09-26' },
          { account: 'Card', amount: 800, payee: 'PAYMENT ONE', date: '2026-09-25' },
          { account: 'Card', amount: -45.5, payee: 'Supermarket', date: '2026-09-25' },
          { account: 'Card', amount: 800, payee: 'PAYMENT TWO', date: '2026-09-27' },
        ],
      });
      const text = lines.join('\n');

      expect(text.match(/is the other side of the transfer/g)).toHaveLength(2);
      expect(text).toContain('row 3  Card');
      expect(text).toContain('row 5  Card');
    }, 60_000);

    it('pairs every row it can, not the nearest one first', async () => {
      // Two transfers and two credits, with the card posting a day late.
      // Taking the exact-date pair first uses up the transfer the second
      // credit needs, and that credit is then left out of the message and
      // counted among the rows that were fine. The person sends the list
      // again without the row they were told about, and the other one
      // collides on the second attempt.
      await budget('batch-max-pairing');

      const lines = await createTransactions({
        transactions: [
          { account: 'Bank', amount: -800, payee: 'Card', date: '2026-09-25' },
          { account: 'Bank', amount: -800, payee: 'Card', date: '2026-09-26' },
          { account: 'Card', amount: 800, payee: 'PAYMENT ONE', date: '2026-09-26' },
          { account: 'Card', amount: 800, payee: 'PAYMENT TWO', date: '2026-09-27' },
        ],
      });
      const text = lines.join('\n');

      expect(text.match(/is the other side of the transfer/g)).toHaveLength(2);
      expect(text).toContain('row 3  Card');
      expect(text).toContain('row 4  Card');
      expect(text, 'a row that collides was counted among the ones that were fine').not.toMatch(
        /other 3 rows were fine/,
      );
    }, 60_000);

    it('does not let a repeated row take a transfer with it', async () => {
      // The batch holds the same credit twice. The repeat is reported as a
      // repeat, and if it still takes a transfer, its twin is never named and
      // the reply counts it among the rows that were fine, so the person
      // sends it again and hits the collision on the second attempt.
      await budget('batch-repeat-takes-transfer');

      const lines = await createTransactions({
        transactions: [
          { account: 'Bank', amount: -800, payee: 'Card', date: '2026-09-24' },
          { account: 'Bank', amount: -800, payee: 'Card', date: '2026-09-25' },
          { account: 'Card', amount: 800, payee: 'PAYMENT ONE', date: '2026-09-24' },
          { account: 'Card', amount: 800, payee: 'PAYMENT ONE', date: '2026-09-24' },
          { account: 'Card', amount: 800, payee: 'PAYMENT TWO', date: '2026-09-25' },
        ],
      });
      const rows = lines.join('\n').split('\n');

      const third = rows.findIndex((l) => l.includes('row 3  Card'));
      const fourth = rows.findIndex((l) => l.includes('row 4  Card'));
      const fifth = rows.findIndex((l) => l.includes('row 5  Card'));

      // Row 3 pairs with the transfer on its own date, row 5 with the other,
      // and row 4 is only the repeat.
      expect(rows[third + 1]).toContain('transfer in row 1');
      expect(rows[fourth + 1]).toContain('repeats row 3');
      expect(fifth, 'the row that collides was left out of the message').toBeGreaterThan(-1);
      expect(rows[fifth + 1]).toContain('transfer in row 2');
      // Three of the five collide, and the two that are counted as fine are
      // the transfers, which do. Before this, row 5 was among them.
      expect(lines[0]).toContain('3 of 5 rows could not be used');
      expect(lines.join('\n')).toContain('The other 2 rows were fine');
    }, 60_000);

    it('pairs every row it can with the transfers sent the other way round', async () => {
      await budget('batch-max-pairing-reversed');

      const lines = await createTransactions({
        transactions: [
          { account: 'Bank', amount: -800, payee: 'Card', date: '2026-09-26' },
          { account: 'Bank', amount: -800, payee: 'Card', date: '2026-09-25' },
          { account: 'Card', amount: 800, payee: 'PAYMENT ONE', date: '2026-09-27' },
          { account: 'Card', amount: 800, payee: 'PAYMENT TWO', date: '2026-09-26' },
        ],
      });
      const text = lines.join('\n');

      expect(text.match(/is the other side of the transfer/g)).toHaveLength(2);
      expect(text).toContain('row 3  Card');
      expect(text).toContain('row 4  Card');
    }, 60_000);

    it('pairs each transfer with the row on its own date', async () => {
      // Two of each, one pair on the 25th and one on the 26th. Taking the
      // first transfer that fits crossed them, so a row was told it repeated
      // a transfer two days away while its own twin sat on the same date.
      await budget('batch-one-to-one-pairs');

      const lines = await createTransactions({
        transactions: [
          { account: 'Bank', amount: -800, payee: 'Card', date: '2026-09-25' },
          { account: 'Bank', amount: -800, payee: 'Card', date: '2026-09-26' },
          { account: 'Card', amount: 800, payee: 'PAYMENT ONE', date: '2026-09-25' },
          { account: 'Card', amount: 800, payee: 'PAYMENT TWO', date: '2026-09-26' },
        ],
      });
      const text = lines.join('\n');

      // Row 3 is dated the 25th, so it belongs to row 1; row 4 to row 2.
      const third = text.split('\n').findIndex((l) => l.includes('row 3  Card'));
      const fourth = text.split('\n').findIndex((l) => l.includes('row 4  Card'));
      expect(third).toBeGreaterThan(-1);
      expect(fourth).toBeGreaterThan(-1);
      expect(text.split('\n')[third + 1]).toContain('transfer in row 1');
      expect(text.split('\n')[fourth + 1]).toContain('transfer in row 2');
    }, 60_000);
  });

  describe('through create_transfer', () => {
    // The batch learned this in 0.10.4 and the single transfer did not, so a
    // monthly import still duplicated through that door. Measured before
    // fixing it: with the payment already imported into the destination, the
    // transfer wrote its own leg on top, on the same day and a day apart
    // alike.
    type Handler = (a: Record<string, unknown>) => Promise<{
      content: Array<{ type: string; text: string }>;
    }>;

    const transferHandler = async (): Promise<Handler> => {
      const { registerCreateTransfer } = await import('../../write/create-transfer.js');
      let handler: Handler | undefined;
      registerCreateTransfer({
        tool: (...a: unknown[]) => {
          handler = a.at(-1) as Handler;
        },
      } as never);
      return handler as Handler;
    };

    const CASES = [
      { label: 'the same day', imported: '2026-09-25', transfer: '2026-09-25', refused: true },
      { label: 'a day apart', imported: '2026-09-26', transfer: '2026-09-25', refused: true },
      { label: 'two days apart', imported: '2026-09-27', transfer: '2026-09-25', refused: false },
    ] as const;

    for (const c of CASES) {
      it(`${c.label}: ${c.refused ? 'refused' : 'written'}`, async () => {
        await budget(`transfer-${c.label.replace(/\W+/g, '-')}`, async () => {
          const accounts = await api.getAccounts();
          await api.addTransactions(
            accounts.find((a) => a.name === 'Card')!.id,
            [{ date: c.imported, amount: 80000, payee_name: 'PAYMENT RECEIVED' }] as never,
            { learnCategories: false, runTransfers: false },
          );
        });
        const beforeCard = await count(card);

        const result = await (await transferHandler())({
          from_account: 'Bank',
          to_account: 'Card',
          amount: 800,
          date: c.transfer,
        });
        for (let i = 0; i < 6; i += 1) await api.getCategories();

        if (c.refused) {
          expect(await count(card), 'the money arrived twice').toBe(beforeCard);
          const text = result.content[0].text;
          expect(text).toContain('already has the other side of this movement');
          // The dates, from the dates: "the same day" when they are, and both
          // of them when they are not.
          if (c.imported === c.transfer) {
            expect(text).toContain(`on the same day: ${c.transfer}`);
          } else {
            expect(text).toContain(c.imported);
            expect(text).toContain(c.transfer);
            expect(text, 'called two different days the same day').not.toContain('the same day');
          }
        } else {
          expect(await count(card)).toBe(beforeCard + 1);
        }
      }, 60_000);
    }

    it('lays the two dates out instead of running them into a sentence', async () => {
      // The dates are what the reader has to compare, and a window of a day
      // means they differ.
      await budget('transfer-date-layout', async () => {
        const accounts = await api.getAccounts();
        await api.addTransactions(
          accounts.find((a) => a.name === 'Card')!.id,
          [{ date: '2026-09-26', amount: 80000, payee_name: 'PAYMENT RECEIVED' }] as never,
          { learnCategories: false, runTransfers: false },
        );
      });

      const result = await (await transferHandler())({
        from_account: 'Bank',
        to_account: 'Card',
        amount: 800,
        date: '2026-09-25',
      });
      const text = result.content[0].text;

      expect(text).toContain('already there: 2026-09-26');
      expect(text).toContain('this row:      2026-09-25');
    }, 60_000);

    it('does not call two dates a day apart when one of them is not', async () => {
      // Two rows match, one on the transfer's own date and one the day
      // before. Summarising that as "a day apart" is false for half of it.
      await budget('transfer-mixed-dates', async () => {
        const accounts = await api.getAccounts();
        await api.addTransactions(
          accounts.find((a) => a.name === 'Card')!.id,
          [
            { date: '2026-09-25', amount: 80000, payee_name: 'PAYMENT ONE' },
            { date: '2026-09-24', amount: 80000, payee_name: 'PAYMENT TWO' },
          ] as never,
          { learnCategories: false, runTransfers: false },
        );
      });

      const result = await (await transferHandler())({
        from_account: 'Bank',
        to_account: 'Card',
        amount: 800,
        date: '2026-09-25',
      });
      const text = result.content[0].text;

      expect(text, 'summarised two different relationships as one').not.toContain('a day apart');
      expect(text).toContain('on these dates:');
      expect(text).toContain('2026-09-25');
      expect(text).toContain('2026-09-24');
    }, 60_000);

    it('says rows in the plural when it found more than one', async () => {
      await budget('transfer-plural', async () => {
        const accounts = await api.getAccounts();
        await api.addTransactions(
          accounts.find((a) => a.name === 'Card')!.id,
          [
            { date: '2026-09-25', amount: 80000, payee_name: 'PAYMENT ONE' },
            { date: '2026-09-26', amount: 80000, payee_name: 'PAYMENT TWO' },
          ] as never,
          { learnCategories: false, runTransfers: false },
        );
      });

      const result = await (await transferHandler())({
        from_account: 'Bank',
        to_account: 'Card',
        amount: 800,
        date: '2026-09-25',
      });
      const text = result.content[0].text;

      expect(text).toMatch(/2 rows that could be the other side/);
      expect(text).toContain('If the rows above are this same payment');
      expect(text, 'spoke of one row while naming two').not.toContain('If the row above is');
    }, 60_000);

    it('writes it when the caller says it is a different movement', async () => {
      await budget('transfer-allowed', async () => {
        const accounts = await api.getAccounts();
        await api.addTransactions(
          accounts.find((a) => a.name === 'Card')!.id,
          [{ date: '2026-09-25', amount: 80000, payee_name: 'PAYMENT RECEIVED' }] as never,
          { learnCategories: false, runTransfers: false },
        );
      });
      const beforeCard = await count(card);

      await (await transferHandler())({
        from_account: 'Bank',
        to_account: 'Card',
        amount: 800,
        date: '2026-09-25',
        allow_duplicate: true,
      });
      for (let i = 0; i < 6; i += 1) await api.getCategories();

      expect(await count(card)).toBe(beforeCard + 1);
    }, 60_000);

    it('is not stopped by a counterpart that is already linked', async () => {
      // The far leg of an earlier transfer is not a loose import, so a second
      // transfer between the same accounts is judged by the existing
      // duplicate check and not by this one.
      await budget('transfer-linked');
      const handler = await transferHandler();

      await handler({ from_account: 'Bank', to_account: 'Card', amount: 800, date: '2026-09-25' });
      for (let i = 0; i < 6; i += 1) await api.getCategories();
      const afterFirst = await count(card);

      const second = await handler({
        from_account: 'Bank',
        to_account: 'Card',
        amount: 800,
        date: '2026-09-26',
      });
      for (let i = 0; i < 6; i += 1) await api.getCategories();

      expect(await count(card), 'a second transfer a day later was refused').toBe(afterFirst + 1);
      expect(second.content[0].text).toContain('Transfer created');
    }, 60_000);
  });
});
