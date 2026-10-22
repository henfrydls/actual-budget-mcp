import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@actual-app/api', () => ({
  default: {},
  getAccounts: vi.fn(),
  getPayees: vi.fn(),
  getTransactions: vi.fn(),
  runBankSync: vi.fn(),
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
import { registerRunBankSync } from '../write/run-bank-sync.js';

type Handler = (args: Record<string, unknown>) => Promise<{
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}>;

function handlerFor(): Handler {
  let handler: Handler | undefined;
  registerRunBankSync({
    tool: (...a: unknown[]) => {
      handler = a.at(-1) as Handler;
    },
  } as never);
  return handler as Handler;
}

const today = new Date().toISOString().slice(0, 10);

/**
 * What `run_bank_sync` answers with (#221).
 *
 * It reported that the sync had run, which is the one thing the caller
 * already knew: whether anything came in, and what, took another call. From
 * 26.11 the engine says what it added and matched, so the reply says it too.
 *
 * Stubbed because the engine in the harness has no bank to link. What is
 * exercised here is the handler's own behaviour on each shape the library
 * can answer with.
 */
describe('what run_bank_sync says afterwards', () => {
  beforeEach(() => {
    vi.mocked(api.getAccounts).mockReset().mockResolvedValue([
      { id: 'a1', name: 'Checking', closed: false },
      { id: 'a2', name: 'Card', closed: false },
    ] as never);
    vi.mocked(api.getPayees).mockReset().mockResolvedValue([
      { id: 'p1', name: 'Corner Shop' },
    ] as never);
    vi.mocked(api.getTransactions).mockReset().mockResolvedValue([
      { id: 't1', date: today, amount: -4550, payee: 'p1' },
    ] as never);
    vi.mocked(api.runBankSync).mockReset();
  });

  it('says what came in, for one account', async () => {
    vi.mocked(api.runBankSync).mockResolvedValue({
      newTransactions: ['t1'],
      matchedTransactions: ['m1', 'm2'],
      updatedAccounts: ['a1'],
    } as never);

    const result = await handlerFor()({ account: 'Checking' });

    expect(result.isError).toBeFalsy();
    const text = result.content[0].text;
    expect(text).toContain('Bank sync completed for: Checking');
    expect(text).toContain('1 new transaction, 2 matched to rows already there.');
    expect(text).toContain('Corner Shop');
  });

  it('says what came in across all of them', async () => {
    vi.mocked(api.runBankSync).mockResolvedValue({
      newTransactions: ['t1'],
      matchedTransactions: [],
      updatedAccounts: ['a1'],
    } as never);

    const result = await handlerFor()({});

    expect(result.isError).toBeFalsy();
    const text = result.content[0].text;
    expect(text).toContain('Bank sync completed for all linked accounts (2 accounts).');
    expect(text).toContain('1 new transaction, 0 matched');
  });

  it('says nothing new came in when nothing did', async () => {
    vi.mocked(api.runBankSync).mockResolvedValue({
      newTransactions: [],
      matchedTransactions: [],
      updatedAccounts: [],
    } as never);

    const text = (await handlerFor()({})).content[0].text;

    expect(text).toContain('Nothing new came in.');
  });

  it('answers as it always did on a library that reports nothing', async () => {
    // The pinned library returns undefined. The reply is the old one, which
    // is the most that can honestly be said there.
    vi.mocked(api.runBankSync).mockResolvedValue(undefined as never);

    const text = (await handlerFor()({})).content[0].text;

    expect(text).toBe('Bank sync completed for all linked accounts (2 accounts).');
  });

  it('still explains an unlinked account rather than reporting a sync', async () => {
    vi.mocked(api.runBankSync).mockRejectedValue(new Error('Account is not linked to a bank'));

    const result = await handlerFor()({});

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('GoCardless or SimpleFIN');
  });
});
