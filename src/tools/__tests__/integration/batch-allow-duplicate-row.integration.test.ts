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

  async function freshBudget(name: string): Promise<void> {
    await createFreshBudget(async () => {
      checkingId = (await api.createAccount(
        { name: 'Checking', offbudget: false } as never,
        0,
      )) as string;
      await api.createAccount({ name: 'Savings', offbudget: true } as never, 0);
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
    // And the advice, which belongs to a row that was refused.
    expect(text).toContain('If both really happened, pass allow_duplicate.');
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
    expect(text).not.toContain('If both really happened, pass allow_duplicate.');
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
