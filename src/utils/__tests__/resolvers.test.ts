import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@actual-app/api', () => ({
  default: {},
  getAccounts: vi.fn(),
  getCategories: vi.fn(),
  getCategoryGroups: vi.fn(),
  getPayees: vi.fn(),
  utils: {
    amountToInteger: (amount: number) => Math.round(amount * 100),
    integerToAmount: (cents: number) => cents / 100,
  },
}));

vi.mock('../../connection.js', () => ({
  ensureConnection: vi.fn().mockResolvedValue(undefined),
}));

import * as api from '@actual-app/api';
import { resolveAccountId, resolveCategoryId, resolveCategoryGroupId, resolvePayeeId, resolvePayeeName } from '../resolvers.js';

describe('resolveAccountId', () => {
  beforeEach(() => {
    vi.mocked(api.getAccounts).mockResolvedValue([
      { id: 'acc-1', name: 'Crédito Personal', closed: false, offbudget: false },
      { id: 'acc-2', name: 'Travel Card (local)', closed: false, offbudget: false },
      { id: 'acc-3', name: 'Travel Card (foreign)', closed: false, offbudget: false },
      { id: 'acc-4', name: 'Closed Account', closed: true, offbudget: false },
    ] as any);
  });

  it('resolves by exact ID', async () => {
    expect(await resolveAccountId('acc-1')).toBe('acc-1');
  });

  it('resolves by partial name (case-insensitive)', async () => {
    expect(await resolveAccountId('crédito')).toBe('acc-1');
  });

  it('throws on no match', async () => {
    await expect(resolveAccountId('nonexistent')).rejects.toThrow('No account found');
  });

  it('throws on ambiguous match', async () => {
    await expect(resolveAccountId('Travel Card')).rejects.toThrow('Ambiguous account name');
  });

  // #27: exact name match must win over substring matches
  it('prefers exact name over substring when name is a prefix of another', async () => {
    vi.mocked(api.getAccounts).mockResolvedValue([
      { id: 'sav-1', name: 'Savings', closed: false, offbudget: false },
      { id: 'sav-2', name: 'Savings - Emergency Fund', closed: false, offbudget: false },
    ] as any);
    expect(await resolveAccountId('Savings')).toBe('sav-1');
  });

  it('exact name match is case-insensitive', async () => {
    vi.mocked(api.getAccounts).mockResolvedValue([
      { id: 'sav-1', name: 'Savings', closed: false, offbudget: false },
      { id: 'sav-2', name: 'Savings - Emergency Fund', closed: false, offbudget: false },
    ] as any);
    expect(await resolveAccountId('savings')).toBe('sav-1');
  });

  it('excludes closed accounts from name matching', async () => {
    await expect(resolveAccountId('Closed')).rejects.toThrow('No account found');
  });

  it('lists available accounts in error', async () => {
    try {
      await resolveAccountId('xyz');
    } catch (e: any) {
      expect(e.message).toContain('Crédito Personal');
    }
  });
});

describe('resolveCategoryId', () => {
  beforeEach(() => {
    vi.mocked(api.getCategories).mockResolvedValue([
      { id: 'cat-1', name: 'Alimentación', group_id: 'grp-1', hidden: false },
      { id: 'cat-2', name: 'Combustible', group_id: 'grp-1', hidden: false },
      { id: 'cat-3', name: 'Bono Combustible', group_id: 'grp-2', hidden: false },
      { id: 'cat-4', name: 'Hidden Cat', group_id: 'grp-1', hidden: true },
    ] as any);
  });

  it('resolves by exact ID', async () => {
    expect(await resolveCategoryId('cat-1')).toBe('cat-1');
  });

  it('resolves by name', async () => {
    expect(await resolveCategoryId('Alimentación')).toBe('cat-1');
  });

  // #22: exact name match must win over substring matches.
  it('prefers exact name over substring', async () => {
    expect(await resolveCategoryId('Combustible')).toBe('cat-2');
  });

  it('still throws ambiguous when no exact match exists but several substrings do', async () => {
    await expect(resolveCategoryId('ombustible')).rejects.toThrow('Ambiguous category name');
  });

  // #23: a valid category UUID must resolve to itself (id match before name match)
  it('resolves a category passed as UUID', async () => {
    expect(await resolveCategoryId('cat-3')).toBe('cat-3');
  });

  it('excludes hidden categories', async () => {
    await expect(resolveCategoryId('Hidden')).rejects.toThrow('No category found');
  });

  it('throws on no match', async () => {
    await expect(resolveCategoryId('nonexistent')).rejects.toThrow('No category found');
  });
});

describe('resolveCategoryGroupId', () => {
  beforeEach(() => {
    vi.mocked(api.getCategoryGroups).mockResolvedValue([
      { id: 'grp-1', name: 'Gastos Fijos', is_income: false },
      { id: 'grp-2', name: 'Gastos Variables', is_income: false },
      { id: 'grp-3', name: 'Income', is_income: true },
    ] as any);
  });

  it('resolves by exact ID', async () => {
    expect(await resolveCategoryGroupId('grp-1')).toBe('grp-1');
  });

  it('resolves by partial name', async () => {
    expect(await resolveCategoryGroupId('Fijos')).toBe('grp-1');
  });

  it('throws on ambiguous match', async () => {
    await expect(resolveCategoryGroupId('Gastos')).rejects.toThrow('Ambiguous category group name');
  });

  it('throws on no match', async () => {
    await expect(resolveCategoryGroupId('nonexistent')).rejects.toThrow('No category group found');
  });

  // #27/#22 same defect: exact group name must win over substring
  it('prefers exact group name over substring', async () => {
    vi.mocked(api.getCategoryGroups).mockResolvedValue([
      { id: 'g-1', name: 'Gastos', is_income: false },
      { id: 'g-2', name: 'Gastos Fijos', is_income: false },
    ] as any);
    expect(await resolveCategoryGroupId('Gastos')).toBe('g-1');
  });

  it('lists available groups in error', async () => {
    try {
      await resolveCategoryGroupId('xyz');
    } catch (e: any) {
      expect(e.message).toContain('Gastos Fijos');
      expect(e.message).toContain('Income');
    }
  });
});

describe('resolvePayeeId', () => {
  beforeEach(() => {
    vi.mocked(api.getPayees).mockResolvedValue([
      { id: 'pay-1', name: 'Sirena' },
      { id: 'pay-2', name: 'DGII' },
      { id: 'pay-3', name: 'Transfer: Crédito Personal' },
      { id: 'pay-4', name: '' },
    ] as any);
  });

  it('resolves by exact ID', async () => {
    expect(await resolvePayeeId('pay-1')).toBe('pay-1');
  });

  it('resolves by name', async () => {
    expect(await resolvePayeeId('Sirena')).toBe('pay-1');
  });

  it('excludes transfer payees', async () => {
    await expect(resolvePayeeId('Transfer')).rejects.toThrow('No payee found');
  });

  it('excludes empty-named payees', async () => {
    // Empty name payee should not be findable
    const result = await resolvePayeeId('DGII');
    expect(result).toBe('pay-2');
  });

  it('throws on no match', async () => {
    await expect(resolvePayeeId('nonexistent')).rejects.toThrow('No payee found');
  });

  // #27/#22 same defect: exact payee name must win over substring
  it('prefers exact payee name over substring', async () => {
    vi.mocked(api.getPayees).mockResolvedValue([
      { id: 'u-1', name: 'Uber' },
      { id: 'u-2', name: 'Uber Eats' },
    ] as any);
    expect(await resolvePayeeId('Uber')).toBe('u-1');
  });

  it('lists available payees in error', async () => {
    try {
      await resolvePayeeId('xyz');
    } catch (e: any) {
      expect(e.message).toContain('Sirena');
      expect(e.message).toContain('DGII');
      expect(e.message).not.toContain('Transfer');
    }
  });
});

describe('resolvePayeeName', () => {
  beforeEach(() => {
    vi.mocked(api.getPayees).mockResolvedValue([
      { id: 'pay-1', name: 'Sirena' },
      // Actual stores an account's transfer payee with an empty name.
      { id: 'transfer-1', name: '', transfer_acct: 'acct-1' },
    ] as any);
  });

  it('matches a payee by name, case-insensitively', async () => {
    expect(await resolvePayeeName('sirena')).toBe('pay-1');
  });

  it('returns undefined for an unknown name', async () => {
    expect(await resolvePayeeName('Nobody')).toBeUndefined();
  });

  it('never resolves a blank name to a transfer payee', async () => {
    // A blank name matching a transfer payee would silently turn a plain
    // transaction into a one-sided transfer.
    expect(await resolvePayeeName('')).toBeUndefined();
  });

  it('ignores transfer payees when matching', async () => {
    vi.mocked(api.getPayees).mockResolvedValue([
      { id: 'transfer-2', name: 'Savings', transfer_acct: 'acct-2' },
    ] as any);

    expect(await resolvePayeeName('Savings')).toBeUndefined();
  });
});

/**
 * An ambiguous name, answered with something to choose between (#222).
 *
 * `Matches: Ahorro, Ahorro` is one name printed twice and nothing to act on,
 * and the server's own instructions say an ambiguous name is refused with
 * the ids to choose from. `resolveCategoryId` has said it that way since
 * #218; the rest said only the names.
 */
describe('what an ambiguous name answers with', () => {
  it('names the accounts and their ids', async () => {
    vi.mocked(api.getAccounts).mockResolvedValue([
      { id: 'acc-1', name: 'Savings', closed: false, offbudget: false },
      { id: 'acc-2', name: 'Savings', closed: false, offbudget: false },
    ] as never);

    await expect(resolveAccountId('Savings')).rejects.toThrow(
      /Ambiguous account name "Savings"\. Matches: Savings \(acc-1\); Savings \(acc-2\)\. Pass the id/,
    );
  });

  it('names the category groups and their ids', async () => {
    vi.mocked(api.getCategoryGroups).mockResolvedValue([
      { id: 'g-1', name: 'Everyday' },
      { id: 'g-2', name: 'Everyday' },
    ] as never);

    await expect(resolveCategoryGroupId('Everyday')).rejects.toThrow(
      /Matches: Everyday \(g-1\); Everyday \(g-2\)\. Pass the id/,
    );
  });

  it('names the payees and their ids', async () => {
    vi.mocked(api.getPayees).mockResolvedValue([
      { id: 'p-1', name: 'Corner Shop' },
      { id: 'p-2', name: 'Corner Shop' },
    ] as never);

    await expect(resolvePayeeId('Corner Shop')).rejects.toThrow(
      /Matches: Corner Shop \(p-1\); Corner Shop \(p-2\)\. Pass the id/,
    );
  });

  it('names the group in a batch, where the categories come as a list', async () => {
    // `create_transactions` resolves against a list it already has rather
    // than asking per row, so it takes a different path to the same
    // sentence. It now passes the groups too, which is what tells two
    // categories of the same name apart to whoever reads the reply.
    const { resolveCategoryIn } = await import('../resolvers.js');

    expect(() =>
      resolveCategoryIn(
        [
          { id: 'c-1', name: 'Groceries', group_id: 'g-1', hidden: false },
          { id: 'c-2', name: 'Groceries', group_id: 'g-2', hidden: false },
        ],
        'Groceries',
        [
          { id: 'g-1', name: 'Everyday' },
          { id: 'g-2', name: 'Archive' },
        ],
      ),
    ).toThrow(/Groceries in Everyday \(c-1\); Groceries in Archive \(c-2\)\. Pass the id/);
  });

  it('still names the ids without the groups, which is what it had before', async () => {
    const { resolveCategoryIn } = await import('../resolvers.js');

    expect(() =>
      resolveCategoryIn(
        [
          { id: 'c-1', name: 'Groceries', group_id: 'g-1', hidden: false },
          { id: 'c-2', name: 'Groceries', group_id: 'g-2', hidden: false },
        ],
        'Groceries',
      ),
    ).toThrow(/Matches: Groceries \(c-1\); Groceries \(c-2\)\. Pass the id/);
  });

  it('names the categories and their ids, with the group they are in', async () => {
    // This one says more, and has since #218: which group each is in, and
    // whether it is hidden. What it shares with the others is the ids.
    vi.mocked(api.getCategories).mockResolvedValue([
      { id: 'c-1', name: 'Groceries', group_id: 'g-1', hidden: false },
      { id: 'c-2', name: 'Groceries', group_id: 'g-2', hidden: false },
    ] as never);
    vi.mocked(api.getCategoryGroups).mockResolvedValue([
      { id: 'g-1', name: 'Everyday' },
      { id: 'g-2', name: 'Archive' },
    ] as never);

    await expect(resolveCategoryId('Groceries')).rejects.toThrow(
      /Groceries in Everyday \(c-1\); Groceries in Archive \(c-2\)\. Pass the id/,
    );
  });
});
