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
import { resolveAccountId, resolveCategoryId, resolveCategoryGroupId, resolvePayeeId } from '../resolvers.js';

describe('resolveAccountId', () => {
  beforeEach(() => {
    vi.mocked(api.getAccounts).mockResolvedValue([
      { id: 'acc-1', name: 'BHD Nómina', closed: false, offbudget: false },
      { id: 'acc-2', name: 'BHD Mi Pais (Pesos)', closed: false, offbudget: false },
      { id: 'acc-3', name: 'BHD Mi Pais (Dolares)', closed: false, offbudget: false },
      { id: 'acc-4', name: 'Closed Account', closed: true, offbudget: false },
    ] as any);
  });

  it('resolves by exact ID', async () => {
    expect(await resolveAccountId('acc-1')).toBe('acc-1');
  });

  it('resolves by partial name (case-insensitive)', async () => {
    expect(await resolveAccountId('nómina')).toBe('acc-1');
  });

  it('throws on no match', async () => {
    await expect(resolveAccountId('nonexistent')).rejects.toThrow('No account found');
  });

  it('throws on ambiguous match', async () => {
    await expect(resolveAccountId('BHD Mi Pais')).rejects.toThrow('Ambiguous account name');
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
      expect(e.message).toContain('BHD Nómina');
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
      { id: 'pay-3', name: 'Transfer: BHD Nómina' },
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
