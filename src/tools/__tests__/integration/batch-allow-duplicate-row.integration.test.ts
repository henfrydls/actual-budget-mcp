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
 * Letting one row through the duplicate checks (#175).
 *
 * `allow_duplicate` was all or nothing: to let through the one row that
 * really is a second movement, two coffees of the same price on the same card
 * on the same day, the checks had to come off every row in the call. A batch
 * is written in one go, so there was no second pass where the rest would
 * still be checked.
 */
describe.skipIf(skip)('allow_duplicate on one row', () => {
  let checkingId = '';
  let cardId = '';

  async function freshBudget(name: string): Promise<void> {
    await createFreshBudget(async () => {
      checkingId = (await api.createAccount(
        { name: 'Checking', offbudget: false } as never,
        0,
      )) as string;
      await api.createAccount({ name: 'Savings', offbudget: true } as never, 0);
      cardId = (await api.createAccount({ name: 'Card', offbudget: false } as never, 0)) as string;
    }, name);
  }

  const rowsIn = async (accountId: string) =>
    (await api.getTransactions(accountId, '2000-01-01', '2100-01-01')) as Array<{ amount: number }>;

  beforeAll(async () => {
    await initTestEngine();
  }, 60_000);

  afterAll(async () => {
    await shutdownTestEngine();
  });

  it('lets the marked row in and keeps the checks on the others', async () => {
    await freshBudget('allow-row');
    const lines = await createTransactions({
      transactions: [
        { account: 'Checking', amount: -4.5, payee: 'Cafe', date: '2026-10-12' },
        // The second coffee, which really happened.
        {
          account: 'Checking',
          amount: -4.5,
          payee: 'Cafe',
          date: '2026-10-12',
          allow_duplicate: true,
        },
        { account: 'Checking', amount: -20, payee: 'Shop', date: '2026-10-12' },
      ],
    } as never);
    const text = lines.join('\n');

    expect(text).toContain('Created 3 transactions.');
    expect((await rowsIn(checkingId)).filter((row) => row.amount === -450)).toHaveLength(2);
  }, 60_000);

  it('does not let a marked row excuse the row on the other side of it', async () => {
    // The one that writes money twice. Row 2 repeats row 1, so it is noted
    // and goes in; row 3 is the other side of row 2's transfer and nothing
    // marked it. With one set for refused and noted rows, the pairing check
    // skipped row 2 because it had been reported, row 3 was never matched
    // against it, and Card ended up with the transfer's leg and row 3: the
    // same money twice, under a reply that said it had created three rows.
    await freshBudget('allow-row-other-side');
    const lines = await createTransactions({
      transactions: [
        { account: 'Checking', amount: -600, payee: 'Shop', date: '2026-10-12' },
        {
          account: 'Checking',
          amount: -600,
          payee: 'Card',
          date: '2026-10-12',
          allow_duplicate: true,
        },
        { account: 'Card', amount: 600, payee: 'PAYMENT RECEIVED', date: '2026-10-12' },
      ],
    } as never);
    const text = lines.join('\n');

    expect(text).toContain('Nothing was created.');
    expect(text).toContain('is the other side of the transfer in row 2');
    expect(await rowsIn(cardId), 'the money would have gone in twice').toHaveLength(0);
  }, 60_000);

  it('does not let a marked row take the transfer an unmarked one needed', async () => {
    // A transfer accounts for one row, and the matching takes the nearest
    // date. The marked row on the 12th is closer to the transfer than the
    // unmarked one on the 13th, so it took the pairing, the unmarked row was
    // never matched and never reported, and Card ended up with the transfer's
    // leg, the marked row and the unmarked one: the last of those twice.
    for (const order of ['marked first', 'unmarked first'] as const) {
      await freshBudget(`allow-row-steals-${order.replace(/ /g, '-')}`);
      const marked = {
        account: 'Card',
        amount: 600,
        payee: 'Cashback',
        date: '2026-10-12',
        allow_duplicate: true,
      };
      const unmarked = { account: 'Card', amount: 600, payee: 'PAYMENT', date: '2026-10-13' };
      const lines = await createTransactions({
        transactions: [
          { account: 'Checking', amount: -600, payee: 'Card', date: '2026-10-12' },
          ...(order === 'marked first' ? [marked, unmarked] : [unmarked, marked]),
        ],
      } as never);
      const text = lines.join('\n');

      expect(text, `${order}: the unmarked row has to be reported`).toContain(
        'Nothing was created.',
      );
      expect(text).toContain('is the other side of the transfer in row 1');
      expect(await rowsIn(cardId), `${order}: nothing goes in`).toHaveLength(0);
    }
  }, 120_000);

  it('tells a repeated transfer from one account apart from the pair of one movement', async () => {
    // The key is the two accounts in the direction the money runs, so it
    // catches the same movement written from each side, and it also catches
    // the same transfer sent twice from one side. "Written from the other
    // account" is false about the second, and sends somebody looking for a
    // row that is not there.
    await freshBudget('allow-row-same-side');
    const lines = await createTransactions({
      transactions: [
        { account: 'Checking', amount: -600, payee: 'Card', date: '2026-10-12' },
        { account: 'Checking', amount: -600, payee: 'Card', date: '2026-10-12' },
      ],
    } as never);
    const text = lines.join('\n');

    expect(text).toContain('the same transfer, from the same account to the same one');
    expect(text).not.toContain('written from the other account');
  }, 60_000);

  it('lists every finding about a row it let through', async () => {
    // One finding per row is a rule about what to fix, and there is nothing
    // to fix on a row that is going in: the second thing found about it was
    // dropped.
    await freshBudget('allow-row-two-findings');
    await createTransactions({
      transactions: [{ account: 'Checking', amount: -4.5, payee: 'Cafe', date: '2026-10-12' }],
    } as never);

    // Both marked, so nothing is refused and the batch goes in. Row 2 is the
    // one with two findings: the row before it in this call, and the one
    // already in the budget from the call before.
    const lines = await createTransactions({
      transactions: [
        {
          account: 'Checking',
          amount: -4.5,
          payee: 'Cafe',
          date: '2026-10-12',
          allow_duplicate: true,
        },
        {
          account: 'Checking',
          amount: -4.5,
          payee: 'Cafe',
          date: '2026-10-12',
          allow_duplicate: true,
        },
      ],
    } as never);
    const text = lines.join('\n');

    expect(text).toContain('Created 2 transactions.');
    expect(text).toContain('repeats row 1');
    expect(text).toContain('already has a transaction on 2026-10-12');
    // Row 2 twice, once per finding.
    expect(text.match(/^ {2}row 2 {2}/gm) ?? []).toHaveLength(2);
  }, 60_000);

  it('still refuses the batch when the repeat is not marked', async () => {
    await freshBudget('allow-row-unmarked');
    const lines = await createTransactions({
      transactions: [
        { account: 'Checking', amount: -4.5, payee: 'Cafe', date: '2026-10-12' },
        { account: 'Checking', amount: -4.5, payee: 'Cafe', date: '2026-10-12' },
      ],
    } as never);
    const text = lines.join('\n');

    expect(text).toContain('Nothing was created.');
    expect(text).toContain('repeats row 1: same account, date and amount.');
    // And the advice, which belongs to a row that was refused, and says
    // which row to put the flag on: with two places to put it, "pass
    // allow_duplicate" was an instruction with two readings, and one of them
    // turns the checks off for the whole call.
    expect(text).toContain('If both really happened, set allow_duplicate on row 2.');
    expect(await rowsIn(checkingId)).toHaveLength(0);
  }, 60_000);

  it('says what the checks found about a row it let through', async () => {
    // A batch sent with the flag used to read exactly like one with nothing
    // wrong in it, so afterwards there was no telling the two apart.
    await freshBudget('allow-row-says');
    const lines = await createTransactions({
      transactions: [
        { account: 'Checking', amount: -4.5, payee: 'Cafe', date: '2026-10-12' },
        {
          account: 'Checking',
          amount: -4.5,
          payee: 'Cafe',
          date: '2026-10-12',
          allow_duplicate: true,
        },
      ],
    } as never);
    const text = lines.join('\n');

    expect(text).toContain('1 row went in with allow_duplicate');
    expect(text).toContain('row 2  Checking  -4.50  2026-10-12');
    expect(text).toContain('repeats row 1: same account, date and amount.');
    // Not the advice: they already did the thing it advises.
    expect(text).not.toContain('set allow_duplicate on row');
  }, 60_000);

  it('says it for a whole batch let through as well', async () => {
    // The call-level flag used to skip the checks, so it could not say this.
    await freshBudget('allow-call-says');
    const lines = await createTransactions({
      transactions: [
        { account: 'Checking', amount: -4.5, payee: 'Cafe', date: '2026-10-12' },
        { account: 'Checking', amount: -4.5, payee: 'Cafe', date: '2026-10-12' },
      ],
      allow_duplicate: true,
    } as never);
    const text = lines.join('\n');

    expect(text).toContain('Created 2 transactions.');
    expect(text).toContain('1 row went in with allow_duplicate');
    expect(text).toContain('repeats row 1');
  }, 60_000);

  it('does not reach the imported_id checks, which are identity', async () => {
    await freshBudget('allow-row-imported');
    const lines = await createTransactions({
      transactions: [
        { account: 'Checking', amount: -4.5, payee: 'Cafe', date: '2026-10-12', imported_id: 'a' },
        {
          account: 'Checking',
          amount: -4.5,
          payee: 'Cafe',
          date: '2026-10-12',
          imported_id: 'a',
          allow_duplicate: true,
        },
      ],
    } as never);
    const text = lines.join('\n');

    expect(text).toContain('Nothing was created.');
    expect(text).toContain('same imported_id');
    expect(await rowsIn(checkingId)).toHaveLength(0);
  }, 60_000);

  it('does not ask the budget about a row it has already refused', async () => {
    // Nothing is written when any row is refused, so those queries buy an
    // answer nobody reads. Counted rather than asserted about, because the
    // only difference it makes is the work.
    await freshBudget('allow-row-queries');
    await createTransactions({
      transactions: [
        { account: 'Checking', amount: -1, payee: 'Cafe', date: '2026-10-12', imported_id: 'a' },
      ],
    } as never);

    const real = api.runQuery;
    let queries = 0;
    (api as { runQuery: unknown }).runQuery = async (...args: unknown[]) => {
      queries += 1;
      return (real as (...a: unknown[]) => unknown)(...args);
    };
    try {
      await createTransactions({
        transactions: [
          // Refused: its id is already in the budget.
          { account: 'Checking', amount: -1, payee: 'Cafe', date: '2026-10-12', imported_id: 'a' },
          { account: 'Checking', amount: -2, payee: 'Shop', date: '2026-10-13' },
          { account: 'Checking', amount: -3, payee: 'Shop', date: '2026-10-14' },
        ],
      } as never);
    } finally {
      (api as { runQuery: unknown }).runQuery = real;
    }

    // One for the imported ids, then one per row the budget is still asked
    // about, which is two of the three.
    expect(queries).toBeLessThanOrEqual(3);
  }, 60_000);

  it('lists both the budget and the other account for one marked row', async () => {
    // The budget check used to end the row's turn, so the one after it never
    // ran: the note said the budget already had this, and said nothing about
    // the transfer putting a second row in the other account as well.
    await freshBudget('allow-row-both-findings');
    await createTransactions({
      transactions: [
        { account: 'Checking', amount: -50, payee: 'Shop', date: '2026-10-01' },
        { account: 'Card', amount: 50, payee: 'PAYMENT', date: '2026-10-01' },
      ],
    } as never);

    const lines = await createTransactions({
      transactions: [
        {
          account: 'Checking',
          amount: -50,
          payee: 'Card',
          date: '2026-10-01',
          allow_duplicate: true,
        },
      ],
    } as never);
    const text = lines.join('\n');

    expect(text).toContain('already has a transaction on 2026-10-01');
    expect(text).toContain('already has a transaction for');
    // One line per finding, and there are at least these two.
    expect((text.match(/^ {2}row 1 {2}/gm) ?? []).length).toBeGreaterThanOrEqual(2);
  }, 60_000);

  it('says nothing about a flag on a row the checks found nothing about', async () => {
    await freshBudget('allow-row-quiet');
    const lines = await createTransactions({
      transactions: [
        { account: 'Checking', amount: -4.5, payee: 'Cafe', date: '2026-10-12' },
        {
          account: 'Checking',
          amount: -9,
          payee: 'Shop',
          date: '2026-10-13',
          allow_duplicate: true,
        },
      ],
    } as never);

    expect(lines.join('\n')).not.toContain('allow_duplicate');
  }, 60_000);
});
