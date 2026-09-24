import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@actual-app/api', () => ({
  default: {},
  getAccounts: vi.fn().mockResolvedValue([
    { id: 'acc-1', name: 'Checking', closed: false, offbudget: false },
    { id: 'acc-2', name: 'Savings', closed: false, offbudget: false },
  ]),
  getPayees: vi.fn().mockResolvedValue([
    { id: 'payee-transfer-2', name: 'Savings', transfer_acct: 'acc-2' },
  ]),
  getTransactions: vi.fn().mockResolvedValue([]),
  addTransactions: vi.fn().mockResolvedValue('ok'),
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
import { registerCreateTransfer } from '../write/create-transfer.js';

/**
 * The tool's logic lives inside its registration, so the handler is captured
 * with a fake server. Before this file the tool had no unit test at all: its
 * whole body could be deleted and the suite stayed green, which an audit of
 * #79 demonstrated by reverting it and finding nothing failed.
 */
type Handler = (input: Record<string, unknown>) => Promise<{
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}>;

function handlerFor(): Handler {
  let captured: Handler | undefined;
  registerCreateTransfer({
    tool: (...args: unknown[]) => {
      captured = args.at(-1) as Handler;
    },
  } as never);
  if (!captured) throw new Error('create_transfer did not register a handler');
  return captured;
}

const transfer = () =>
  handlerFor()({
    from_account: 'Checking',
    to_account: 'Savings',
    amount: 5000,
    date: '2026-09-21',
  });

beforeEach(() => {
  vi.mocked(api.addTransactions).mockReset().mockResolvedValue('ok' as any);
  vi.mocked(api.sync).mockReset().mockResolvedValue(undefined as any);
  vi.mocked(api.getTransactions).mockReset().mockResolvedValue([] as any);
});

describe('create_transfer', () => {
  it('moves the amount out of the source account', async () => {
    const result = await transfer();

    expect(api.addTransactions).toHaveBeenCalledWith(
      'acc-1',
      [expect.objectContaining({ amount: -500000, payee: 'payee-transfer-2' })],
      { runTransfers: true },
    );
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toMatch(/Transfer created/);
  });

  it('refuses when the destination has no transfer payee', async () => {
    vi.mocked(api.getPayees).mockResolvedValueOnce([] as any);

    const result = await transfer();

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/transfer payee/i);
  });
});

/**
 * #79 for transfers. Repeating one moves the money twice and leaves two pairs
 * of linked rows to unpick, which is harder to undo than a duplicate expense.
 */
describe('a transfer that fails after it has already been applied', () => {
  const failure = () =>
    new Error('We had an unknown problem opening "My-Finances-8174eb5"');

  it('does not report a plain failure when the transfer is there', async () => {
    vi.mocked(api.getTransactions)
      .mockResolvedValueOnce([] as any)
      .mockResolvedValueOnce([
        { id: 'txn-new', account: 'acc-1', date: '2026-09-21', amount: -500000, payee: 'payee-transfer-2' },
      ] as any);
    vi.mocked(api.addTransactions).mockRejectedValue(failure());

    const result = await transfer();

    // Not reported as an error: an agent reading "Error:" has every reason to
    // try again, and trying again is what moves the money twice.
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toMatch(/was saved/i);
    expect(result.content[0].text).toMatch(/do not repeat it/i);
    expect(result.content[0].text).not.toMatch(/^Error:/);
  });

  it('says a retry is safe when the transfer is genuinely absent', async () => {
    vi.mocked(api.addTransactions).mockRejectedValue(failure());

    const result = await transfer();

    expect(result.content[0].text).toMatch(/was not saved/i);
    expect(result.content[0].text).toMatch(/can be retried/i);
  });

  it('will not say "not saved" when something unrecognised appeared', async () => {
    // A rule may have rewritten the amount or the date of ours.
    vi.mocked(api.getTransactions)
      .mockResolvedValueOnce([] as any)
      .mockResolvedValueOnce([
        { id: 'other', account: 'acc-1', date: '2026-09-21', amount: -123 },
      ] as any);
    vi.mocked(api.addTransactions).mockRejectedValue(failure());

    expect((await transfer()).content[0].text).toMatch(/could not be.*determined/is);
  });

  it('admits it cannot tell when the budget will not open again either', async () => {
    vi.mocked(api.getTransactions)
      .mockResolvedValueOnce([] as any)
      .mockRejectedValueOnce(failure());
    vi.mocked(api.addTransactions).mockRejectedValue(failure());

    const text = (await transfer()).content[0].text;

    expect(text).toMatch(/could not be.*determined/is);
    expect(text).toMatch(/before trying again/i);
  });

  it('covers the sync step, where the rows are in and the sync is not', async () => {
    vi.mocked(api.getTransactions)
      .mockResolvedValueOnce([] as any)
      .mockResolvedValueOnce([
        { id: 'txn-new', account: 'acc-1', date: '2026-09-21', amount: -500000, payee: 'payee-transfer-2' },
      ] as any);
    vi.mocked(api.sync).mockRejectedValue(failure());

    expect((await transfer()).content[0].text).toMatch(/was saved/i);
  });

  it('leaves an ordinary refusal exactly as it was', async () => {
    vi.mocked(api.addTransactions).mockRejectedValue(new Error('amount is required'));

    expect((await transfer()).content[0].text).toMatch(/amount is required/);
  });
});
