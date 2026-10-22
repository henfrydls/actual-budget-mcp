import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@actual-app/api', () => ({
  default: {},
  getPayees: vi.fn(),
  getTransactions: vi.fn(),
  utils: {
    amountToInteger: (a: number) => Math.round(a * 100),
    integerToAmount: (c: number) => c / 100,
  },
}));

import * as api from '@actual-app/api';
import { describeSync } from '../bank-sync-report.js';

const ACCOUNTS = [
  { id: 'a1', name: 'Checking' },
  { id: 'a2', name: 'Card' },
];

/** A date inside the window the report reads. */
const recent = (daysAgo: number) => {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  return d.toISOString().slice(0, 10);
};

/**
 * What a bank sync brought in (#221).
 *
 * From 26.11 `runBankSync` answers with the ids it added and matched. Before
 * that it answered nothing, and this server could only say the sync had run,
 * which is the one thing the caller already knew.
 *
 * Stubbed rather than run against a bank: the engine in the test harness has
 * no bank to link, and the shapes are what this turns into words.
 */
describe('the report of a bank sync', () => {
  beforeEach(() => {
    vi.mocked(api.getPayees).mockReset().mockResolvedValue([
      { id: 'p1', name: 'Corner Shop' },
      { id: 'p2', name: 'Electricity Board' },
    ] as never);
    vi.mocked(api.getTransactions).mockReset().mockImplementation(async (accountId) =>
      (accountId === 'a1'
        ? [
            { id: 't1', date: recent(2), amount: -4550, payee: 'p1' },
            { id: 't2', date: recent(5), amount: -12000, payee: 'p2' },
            { id: 'old', date: recent(3), amount: -100, payee: 'p1' },
          ]
        : [{ id: 't3', date: recent(1), amount: -999, imported_payee: 'Unknown Shop' }]) as never,
    );
  });

  it('says nothing at all when the library said nothing', async () => {
    // The pinned library returns undefined. Saying "nothing came in" there
    // would be inventing a fact about a sync that may have brought in plenty.
    expect(await describeSync(undefined, ACCOUNTS)).toEqual([]);
    expect(api.getTransactions).not.toHaveBeenCalled();
  });

  it('says nothing new came in when nothing did', async () => {
    const lines = await describeSync(
      { newTransactions: [], matchedTransactions: [], updatedAccounts: [] },
      ACCOUNTS,
    );

    expect(lines).toEqual(['Nothing new came in.']);
    expect(api.getTransactions, 'no ids, no reading').not.toHaveBeenCalled();
  });

  it('counts the matched ones without listing them', async () => {
    const lines = await describeSync(
      { newTransactions: [], matchedTransactions: ['m1', 'm2'], updatedAccounts: ['a1'] },
      ACCOUNTS,
    );

    expect(lines[0]).toBe('0 new transactions, 2 matched to rows already there.');
    expect(lines.join('\n')).not.toContain('m1');
  });

  it('lists what was added, newest first, with the account it landed in', async () => {
    const lines = await describeSync(
      { newTransactions: ['t1', 't2', 't3'], matchedTransactions: ['m1'], updatedAccounts: ['a1', 'a2'] },
      ACCOUNTS,
    );

    const text = lines.join('\n');
    expect(lines[0]).toBe('3 new transactions, 1 matched to rows already there.');
    expect(text).toContain('Corner Shop');
    expect(text).toContain('Electricity Board');
    expect(text).toContain('Checking');
    expect(text).toContain('Card');
    expect(text).toContain('-45.50');
    // Newest first, and the row that was not in the sync is not in the list.
    const dates = lines.filter((l) => l.startsWith('  ')).map((l) => l.trim().slice(0, 10));
    expect([...dates].sort().reverse()).toEqual(dates);
    expect(text).not.toContain('-1.00');
  });

  it('uses the imported name when there is no payee yet', async () => {
    const lines = await describeSync(
      { newTransactions: ['t3'], matchedTransactions: [], updatedAccounts: ['a2'] },
      ACCOUNTS,
    );

    expect(lines.join('\n')).toContain('Unknown Shop');
  });

  it('only opens the accounts the engine said it touched', async () => {
    await describeSync(
      { newTransactions: ['t1'], matchedTransactions: [], updatedAccounts: ['a1'] },
      ACCOUNTS,
    );

    expect(api.getTransactions).toHaveBeenCalledTimes(1);
    expect(api.getTransactions).toHaveBeenCalledWith('a1', expect.any(String), expect.any(String));
  });

  it('reads every account when the engine did not say which', async () => {
    await describeSync({ newTransactions: ['t1'], matchedTransactions: [] }, ACCOUNTS);

    expect(api.getTransactions).toHaveBeenCalledTimes(2);
  });

  it('says how many it could not find rather than letting the figures disagree', async () => {
    const lines = await describeSync(
      { newTransactions: ['t1', 'gone', 'also-gone'], matchedTransactions: [], updatedAccounts: ['a1'] },
      ACCOUNTS,
    );

    const text = lines.join('\n');
    expect(lines[0]).toBe('3 new transactions, 0 matched to rows already there.');
    expect(text).toContain('2 of them are not listed');
    expect(text).toContain('120 days');
  });
});
