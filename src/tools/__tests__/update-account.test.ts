import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@actual-app/api', () => ({
  default: {},
  getAccounts: vi.fn(),
  updateAccount: vi.fn().mockResolvedValue(undefined),
  sync: vi.fn().mockResolvedValue(undefined),
  utils: {
    amountToInteger: (a: number) => Math.round(a * 100),
    integerToAmount: (c: number) => c / 100,
  },
}));

vi.mock('../../connection.js', () => ({
  ensureConnection: vi.fn().mockResolvedValue(undefined),
}));

import * as api from '@actual-app/api';
import { registerUpdateAccount } from '../write/update-account.js';

type Handler = (args: Record<string, unknown>) => Promise<{
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}>;

function handlerFor(): Handler {
  let handler: Handler | undefined;
  registerUpdateAccount({
    tool: (...a: unknown[]) => {
      handler = a.at(-1) as Handler;
    },
  } as never);
  return handler as Handler;
}

const account = (name: string) => ({ id: 'acc-1', name, offbudget: false, closed: false });

/**
 * The part of `update_account` the engine cannot show, because against the
 * real engine a rename always takes.
 */
describe('update_account read-back', () => {
  beforeEach(() => {
    vi.mocked(api.getAccounts).mockReset();
    vi.mocked(api.updateAccount).mockReset().mockResolvedValue(undefined as never);
    vi.mocked(api.sync).mockReset().mockResolvedValue(undefined as never);
  });

  it('does not report a rename the account does not show', async () => {
    // `updateAccount` resolves either way, so a reply that trusted it would
    // say the account was renamed while it still answers to the old name.
    vi.mocked(api.getAccounts).mockResolvedValue([account('Main Checking')] as never);

    const result = await handlerFor()({ account: 'Main Checking', name: 'Everyday Account' });

    expect(result.isError).toBe(true);
    const text = result.content[0].text;
    expect(text).toContain('does not read back as "Everyday Account"');
    expect(text).toContain('It is currently "Main Checking"');
    expect(text).not.toContain('Renamed');
  });

  it('reports the rename when the account does show it', async () => {
    // Three reads: `resolveAccountId` makes one of its own, then the tool
    // reads the current name, then it reads back after writing.
    vi.mocked(api.getAccounts)
      .mockResolvedValueOnce([account('Main Checking')] as never)
      .mockResolvedValueOnce([account('Main Checking')] as never)
      .mockResolvedValueOnce([account('Everyday Account')] as never);

    const result = await handlerFor()({ account: 'Main Checking', name: 'Everyday Account' });

    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain('Renamed "Main Checking" to "Everyday Account"');
  });

  it('syncs after writing, before reading back', async () => {
    // Without the sync the read-back can answer from before the write, which
    // would make the verification above agree with a stale row (#105).
    const order: string[] = [];
    let reads = 0;
    vi.mocked(api.getAccounts).mockImplementation(async () => {
      order.push('read');
      reads += 1;
      return [account(reads <= 2 ? 'Main Checking' : 'Everyday Account')] as never;
    });
    vi.mocked(api.updateAccount).mockImplementation(async () => {
      order.push('write');
    });
    vi.mocked(api.sync).mockImplementation(async () => {
      order.push('sync');
    });

    await handlerFor()({ account: 'Main Checking', name: 'Everyday Account' });

    expect(order).toEqual(['read', 'read', 'write', 'sync', 'read']);
  });
});
