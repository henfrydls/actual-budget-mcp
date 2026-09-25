import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

vi.mock('@actual-app/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@actual-app/api')>();
  return { ...actual, sync: vi.fn().mockResolvedValue(undefined) };
});
vi.mock('../../../connection.js', () => ({
  ensureConnection: vi.fn().mockResolvedValue(undefined),
}));

import { initTestEngine, shutdownTestEngine, createFreshBudget, api } from './actual-engine.js';
import { createTransaction } from '../../write/create-transaction.js';

const skip = process.env.SKIP_ACTUAL_INTEGRATION === '1';

/**
 * #88. Two agents against one budget cannot see what the other just wrote, so
 * recording the same payment twice had no signal at all.
 *
 * Each "does not warn" case differs from the existing transaction in exactly
 * one dimension. If a near-match differed in several at once, the test could
 * not say which one spared it — the shape that has produced a test unable to
 * fail four times in this repo.
 */
describe.skipIf(skip)('warning about a transaction that already exists (#88)', () => {
  beforeAll(async () => { await initTestEngine(); }, 60_000);
  afterAll(async () => { await shutdownTestEngine(); });

  async function budgetWith(existing: Array<Record<string, unknown>> = []) {
    let checking = '';
    let savings = '';
    await createFreshBudget(async () => {
      checking = await api.createAccount({ name: 'Checking', type: 'checking' } as any, 0);
      savings = await api.createAccount({ name: 'Savings', type: 'savings' } as any, 0);
    });
    if (existing.length > 0) {
      await api.addTransactions(checking, existing as never);
    }
    return { checking, savings };
  }

  const theOriginal = {
    date: '2026-06-05',
    amount: -5000,
    notes: 'EXISTING-ONE',
  };

  it('names the existing transaction and creates nothing', async () => {
    await budgetWith([theOriginal]);

    const lines = await createTransaction({
      account: 'Checking',
      amount: -50,
      date: '2026-06-05',
    });
    const text = lines.join('\n');

    expect(text).toMatch(/already exists?/i);
    expect(text).toMatch(/EXISTING-ONE/);
    expect(text).toMatch(/allow_duplicate/);
    expect(text).not.toMatch(/Transaction created/);

    // Nothing was written: still one row on that day.
    const rows = await api.getTransactions(
      (await api.getAccounts()).find((a) => a.name === 'Checking')!.id,
      '2026-06-05',
      '2026-06-05',
    );
    expect(rows.length).toBe(1);
  });

  it('does not warn when only the amount differs', async () => {
    await budgetWith([theOriginal]);

    const text = (
      await createTransaction({ account: 'Checking', amount: -50.01, date: '2026-06-05' })
    ).join('\n');

    expect(text).toMatch(/Transaction created/);
  });

  it('does not warn when only the date differs', async () => {
    await budgetWith([theOriginal]);

    const text = (
      await createTransaction({ account: 'Checking', amount: -50, date: '2026-06-06' })
    ).join('\n');

    expect(text).toMatch(/Transaction created/);
  });

  it('does not warn when only the account differs', async () => {
    await budgetWith([theOriginal]);

    const text = (
      await createTransaction({ account: 'Savings', amount: -50, date: '2026-06-05' })
    ).join('\n');

    expect(text).toMatch(/Transaction created/);
  });

  it('does not stop a deliberate duplicate', async () => {
    // Two identical coffees on one card on one day are a real thing.
    const { checking } = await budgetWith([theOriginal]);

    const text = (
      await createTransaction({
        account: 'Checking',
        amount: -50,
        date: '2026-06-05',
        allow_duplicate: true,
      })
    ).join('\n');

    expect(text).toMatch(/Transaction created/);
    const rows = await api.getTransactions(checking, '2026-06-05', '2026-06-05');
    expect(rows.length).toBe(2);
  });

  it('creates normally when the budget is empty', async () => {
    await budgetWith();

    const text = (
      await createTransaction({ account: 'Checking', amount: -50, date: '2026-06-05' })
    ).join('\n');

    expect(text).toMatch(/Transaction created/);
  });

  it('sees a duplicate that is the parent of a split', async () => {
    // The default query adds `WHERE is_parent = 0`, so a duplicated split
    // would be invisible to a check that did not ask for splits — the failure
    // #91 spent four rounds on.
    const { checking } = await budgetWith();
    await api.addTransactions(checking, [
      {
        date: '2026-06-05',
        amount: -7000,
        notes: 'SPLIT-PARENT',
        subtransactions: [{ amount: -4000 }, { amount: -3000 }],
      },
    ] as never);

    const text = (
      await createTransaction({ account: 'Checking', amount: -70, date: '2026-06-05' })
    ).join('\n');

    expect(text).toMatch(/already exists?/i);
    expect(text).toMatch(/SPLIT-PARENT/);
  });

  it('reports every match, not just the first', async () => {
    await budgetWith([theOriginal, { ...theOriginal, notes: 'EXISTING-TWO' }]);

    const text = (
      await createTransaction({ account: 'Checking', amount: -50, date: '2026-06-05' })
    ).join('\n');

    expect(text).toMatch(/2 transactions like this one/);
    expect(text).toMatch(/EXISTING-ONE/);
    expect(text).toMatch(/EXISTING-TWO/);
  });

  it('does not refuse a purchase that matches one share of a split', async () => {
    // Asking for splits returns the children as well as the parent, and a
    // child is not something anyone records twice: it is an internal share,
    // it inherits the parent's payee, and it carries no mark of being part of
    // anything. Reporting one refuses a real purchase and names a row the user
    // cannot find: a -40 chemist's bill refused for matching the -40 share of
    // a -70 supermarket split, under the supermarket's name.
    const { checking } = await budgetWith();
    await api.addTransactions(checking, [
      {
        date: '2026-06-05',
        amount: -7000,
        payee_name: 'PARENTPAYEE-UNIQUE',
        subtransactions: [{ amount: -4000 }, { amount: -3000 }],
      },
    ] as never);

    const text = (
      await createTransaction({
        account: 'Checking',
        amount: -40,
        date: '2026-06-05',
        payee: 'Farmacia',
      })
    ).join('\n');

    expect(text).toMatch(/Transaction created/);
    expect(text).not.toContain('PARENTPAYEE-UNIQUE');
  });

  it('says when the match is the far leg of a transfer', async () => {
    // The other half of a movement is an ordinary row in this account and
    // reads as income already recorded. Reporting it is right; leaving the
    // caller to work out what it is, is not.
    await budgetWith();
    await createTransaction({
      account: 'Checking',
      amount: -500,
      date: '2026-06-05',
      payee: 'Savings',
    });

    const text = (
      await createTransaction({ account: 'Savings', amount: 500, date: '2026-06-05' })
    ).join('\n');

    expect(text).toMatch(/already exists?/i);
    expect(text).toMatch(/transfer/i);
  });

  it('checks against the date it resolved, not the word it was given', async () => {
    // Computed here rather than taken from resolveDate, so the test measures
    // the resolution instead of restating it.
    const now = new Date();
    const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(
      now.getDate(),
    ).padStart(2, '0')}`;

    await budgetWith([{ date: today, amount: -5000, notes: 'EXISTING-TODAY' }]);

    const text = (
      await createTransaction({ account: 'Checking', amount: -50, date: 'today' })
    ).join('\n');

    expect(text).toMatch(/already exists?/i);
    expect(text).toMatch(/EXISTING-TODAY/);
  });
});
