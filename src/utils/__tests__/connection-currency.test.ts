import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const init = vi.fn();
const send = vi.fn();

vi.mock('@actual-app/api', () => ({
  default: {},
  init: (...a: unknown[]) => init(...a),
  downloadBudget: vi.fn().mockResolvedValue(undefined),
  // The budget being open is checked rather than assumed (#139).
  getBudgetMonths: vi.fn().mockResolvedValue(['2026-01']),
  shutdown: vi.fn().mockResolvedValue(undefined),
  utils: {
    amountToInteger: (a: number, places = 2) => Math.round(a * Math.pow(10, places)),
    integerToAmount: (c: number, places = 2) => c / Math.pow(10, places),
  },
}));

/**
 * The wire between the currency and the conversions (#141).
 *
 * `money.ts` reads a count that something has to set, and the module and the
 * tool both pass their own tests with nothing setting it: the default is two,
 * which is right for most currencies, so a missing call looks like a working
 * server to everyone except the three currencies this is for. Deleting the
 * call in `ensureConnection` is the mutation this exists to fail.
 */
describe('a connection picks up the budget currency', () => {
  beforeEach(() => {
    vi.resetModules();
    init.mockReset().mockResolvedValue({ send: (...a: unknown[]) => send(...a) });
    send.mockReset();
    process.env.ACTUAL_SERVER_URL = 'http://localhost:5006';
    process.env.ACTUAL_BUDGET_ID = 'budget-1';
    process.env.ACTUAL_PASSWORD = 'pw';
    process.env.ACTUAL_DATA_DIR = '/tmp/actual-mcp-currency-test';
  });

  afterEach(() => {
    for (const key of [
      'ACTUAL_SERVER_URL',
      'ACTUAL_BUDGET_ID',
      'ACTUAL_PASSWORD',
      'ACTUAL_DATA_DIR',
    ]) {
      delete process.env[key];
    }
  });

  it('converts in the budget currency once connected', async () => {
    send.mockResolvedValue({ defaultCurrencyCode: 'JPY' });
    const { ensureConnection } = await import('../../connection.js');
    const { budgetDecimalPlaces } = await import('../currency.js');
    const { amountToCents } = await import('../money.js');

    // Before connecting, the count is the default, so this proves the
    // connection is what changed it rather than the import order.
    expect(budgetDecimalPlaces()).toBe(2);

    await ensureConnection();

    expect(budgetDecimalPlaces()).toBe(0);
    // The figure from the issue: spending 100 in a budget in yen.
    expect(amountToCents(100)).toBe(100);
  });

  it('connects anyway when the preference cannot be read', async () => {
    // A currency is a formatting detail and a connection is not worth
    // refusing over one. The count stays at the default, which is what every
    // amount was converted with before any of this existed.
    send.mockRejectedValue(new Error('handler is not a function'));
    const { ensureConnection } = await import('../../connection.js');
    const { budgetDecimalPlaces } = await import('../currency.js');

    await expect(ensureConnection()).resolves.toBeUndefined();
    expect(budgetDecimalPlaces()).toBe(2);
  });

  it('forgets the currency when the connection is torn down', async () => {
    // Otherwise a second budget, in another currency, inherits the first
    // one's count until its own preference happens to be read.
    send.mockResolvedValue({ defaultCurrencyCode: 'KRW' });
    const connection = await import('../../connection.js');
    const { budgetDecimalPlaces } = await import('../currency.js');

    await connection.ensureConnection();
    expect(budgetDecimalPlaces()).toBe(0);

    await connection.shutdown();
    expect(budgetDecimalPlaces()).toBe(2);
  });
});
