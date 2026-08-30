import { describe, it, expect, afterEach, vi } from 'vitest';

// Importing the aggregator pulls in every tool module, and each one imports
// @actual-app/api. Mock it so the suite never loads the real SDK bundle just to
// count registrations.
vi.mock('@actual-app/api', () => ({
  default: {},
  utils: {
    amountToInteger: (a: number) => Math.round(a * 100),
    integerToAmount: (c: number) => c / 100,
  },
}));

vi.mock('../../connection.js', () => ({
  ensureConnection: vi.fn().mockResolvedValue(undefined),
  getInternal: vi.fn(),
}));

import { registerAllTools } from '../index.js';

/** Register every tool against a stub server and return the names. */
function registeredToolNames(): string[] {
  const names: string[] = [];
  registerAllTools({
    tool: (name: string) => {
      names.push(name);
    },
  } as never);
  return names;
}

describe('read-only mode hides write tools from discovery', () => {
  afterEach(() => {
    delete process.env.ACTUAL_READ_ONLY;
  });

  it('exposes every tool by default', () => {
    const names = registeredToolNames();

    expect(names).toContain('create_transaction');
    expect(names).toContain('delete_account');
    expect(names.length).toBe(37);
  });

  it('does not register write tools when read-only', () => {
    process.env.ACTUAL_READ_ONLY = '1';
    const names = registeredToolNames();

    expect(names).not.toContain('create_transaction');
    expect(names).not.toContain('delete_account');
    expect(names).not.toContain('run_bank_sync');
  });

  it('keeps the read and analysis tools when read-only', () => {
    process.env.ACTUAL_READ_ONLY = '1';
    const names = registeredToolNames();

    expect(names).toContain('list_accounts');
    expect(names).toContain('get_transactions');
    expect(names).toContain('monthly_summary');
    expect(names.length).toBe(15);
  });

  it('keeps repair_sync available, since a desynced budget needs a way out', () => {
    process.env.ACTUAL_READ_ONLY = '1';

    expect(registeredToolNames()).toContain('repair_sync');
  });
});
