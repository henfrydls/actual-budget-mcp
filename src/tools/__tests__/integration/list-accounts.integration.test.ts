import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

vi.mock('@actual-app/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@actual-app/api')>();
  return { ...actual, sync: vi.fn().mockResolvedValue(undefined) };
});

vi.mock('../../../connection.js', () => ({
  ensureConnection: vi.fn().mockResolvedValue(undefined),
}));

import { initTestEngine, shutdownTestEngine, createFreshBudget, api } from './actual-engine.js';
import { getAccountsReport } from '../../read/list-accounts.js';
import { formatMoney } from '../../../utils/money.js';

const skip = process.env.SKIP_ACTUAL_INTEGRATION === '1';

describe.skipIf(skip)('list_accounts integration (#21 full balance)', () => {
  beforeAll(async () => {
    await initTestEngine();
  }, 60_000);

  afterAll(async () => {
    await shutdownTestEngine();
  });

  it('includes future-dated transactions in the reported balance', async () => {
    let acctId = '';
    const budgetId = await createFreshBudget(async () => {
      acctId = await api.createAccount({ name: 'Checking', type: 'checking' } as any, 0);
      await api.addTransactions(
        acctId,
        [
          { date: '2026-06-05', amount: -1000, payee_name: 'Past' },
          { date: '2030-01-01', amount: -7000, payee_name: 'Future' },
        ] as any,
        { learnCategories: false, runTransfers: false },
      );
    });
    await api.loadBudget(budgetId);

    // Sanity: the SDK's default (no cutoff) drops the future txn (the bug).
    expect(await api.getAccountBalance(acctId)).toBe(-1000);

    // The report must show the FULL balance (-80.00), not the as-of-today one (-10.00).
    const text = await getAccountsReport();
    expect(text).toContain(`Checking: ${formatMoney(-8000)}`);
    expect(text).not.toContain(`Checking: ${formatMoney(-1000)}`);
  }, 60_000);
});
