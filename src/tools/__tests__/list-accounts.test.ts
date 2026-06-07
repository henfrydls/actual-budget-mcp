import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@actual-app/api', () => ({
  default: {},
  getAccounts: vi.fn(),
  getAccountBalance: vi.fn(),
  utils: {
    amountToInteger: (amount: number) => Math.round(amount * 100),
    integerToAmount: (cents: number) => cents / 100,
  },
}));

vi.mock('../../connection.js', () => ({
  ensureConnection: vi.fn().mockResolvedValue(undefined),
}));

import * as api from '@actual-app/api';
import { getAccountsReport } from '../read/list-accounts.js';

describe('getAccountsReport (#21 full balance, not as-of-today)', () => {
  beforeEach(() => {
    vi.mocked(api.getAccounts).mockResolvedValue([
      { id: 'a1', name: 'Checking', closed: false, offbudget: false },
      { id: 'a2', name: 'Wallet', closed: false, offbudget: true },
    ] as any);
    vi.mocked(api.getAccountBalance).mockReset().mockResolvedValue(-8000);
  });

  it('requests a future-inclusive balance so recent/future-dated transactions are not dropped', async () => {
    await getAccountsReport();
    // Without a cutoff the SDK sums only transactions dated <= today, excluding
    // future-dated ones (#21). A far-future cutoff returns the full balance.
    expect(api.getAccountBalance).toHaveBeenCalledWith('a1', new Date('9999-12-31'));
    expect(api.getAccountBalance).toHaveBeenCalledWith('a2', new Date('9999-12-31'));
  });

  it('renders on-budget and off-budget accounts with their balances', async () => {
    const text = await getAccountsReport();
    expect(text).toContain('Checking');
    expect(text).toContain('Wallet');
    expect(text).toMatch(/On-Budget/i);
    expect(text).toMatch(/Off-Budget/i);
  });

  it('excludes closed accounts', async () => {
    vi.mocked(api.getAccounts).mockResolvedValue([
      { id: 'a1', name: 'Open', closed: false, offbudget: false },
      { id: 'a3', name: 'Gone', closed: true, offbudget: false },
    ] as any);
    const text = await getAccountsReport();
    expect(text).toContain('Open');
    expect(text).not.toContain('Gone');
  });
});
