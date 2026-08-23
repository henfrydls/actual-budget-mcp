import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@actual-app/api', () => ({
  default: {},
  createAccount: vi.fn(),
  sync: vi.fn().mockResolvedValue(undefined),
  utils: {
    amountToInteger: (amount: number) => Math.round(amount * 100),
    integerToAmount: (cents: number) => cents / 100,
  },
}));

vi.mock('../../connection.js', () => ({
  ensureConnection: vi.fn().mockResolvedValue(undefined),
}));

import * as api from '@actual-app/api';
import { createNewAccount } from '../write/create-account.js';

describe('createNewAccount (#38)', () => {
  beforeEach(() => {
    vi.mocked(api.createAccount).mockReset().mockResolvedValue('acct-new');
    vi.mocked(api.sync).mockClear().mockResolvedValue(undefined);
  });

  it('creates an on-budget account by default', async () => {
    await createNewAccount({ name: 'Savings' });

    expect(api.createAccount).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'Savings', offbudget: false }),
      0,
    );
  });

  it('creates an off-budget account when asked', async () => {
    await createNewAccount({ name: 'Family Investment', offBudget: true });

    expect(api.createAccount).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'Family Investment', offbudget: true }),
      0,
    );
  });

  it('converts the initial balance to cents', async () => {
    await createNewAccount({ name: 'Wallet', initialBalance: 150.5 });

    expect(api.createAccount).toHaveBeenCalledWith(expect.anything(), 15050);
  });

  it('returns the new account id so transactions can target it', async () => {
    const lines = await createNewAccount({ name: 'Savings' });

    expect(lines.join('\n')).toContain('acct-new');
  });

  it('rejects an empty name', async () => {
    await expect(createNewAccount({ name: '   ' })).rejects.toThrow(/name/i);
    expect(api.createAccount).not.toHaveBeenCalled();
  });

  it('never forwards a field Actual does not model, even if a caller sends one', async () => {
    // Actual models accounts as on/off-budget only — APIAccountEntity has no
    // `type`. Forwarding one is silently dropped by the API, so accepting it
    // would report a change that never happened.
    await createNewAccount({ name: 'Savings', type: 'savings' } as any);

    const account = vi.mocked(api.createAccount).mock.calls[0][0];
    expect(account).not.toHaveProperty('type');
  });

  it('does not claim a type in its output', async () => {
    const lines = await createNewAccount({ name: 'Savings', type: 'savings' } as any);

    expect(lines.join('\n')).not.toMatch(/type/i);
  });
});
