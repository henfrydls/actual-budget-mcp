import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const init = vi.fn();
const downloadBudget = vi.fn();

vi.mock('@actual-app/api', () => ({
  default: {},
  init: (...a: unknown[]) => init(...a),
  downloadBudget: (...a: unknown[]) => downloadBudget(...a),
  shutdown: vi.fn().mockResolvedValue(undefined),
  utils: {
    amountToInteger: (a: number) => Math.round(a * 100),
    integerToAmount: (c: number) => c / 100,
  },
}));

/** The shape Actual throws when nothing is listening: no message, a reason. */
const networkFailure = Object.assign(new Error(''), { reason: 'network-failure' });

describe('connection errors point at the real cause', () => {
  beforeEach(() => {
    vi.resetModules();
    init.mockReset().mockResolvedValue({ send: vi.fn() });
    downloadBudget.mockReset();
    process.env.ACTUAL_SERVER_URL = 'http://localhost:5006';
    process.env.ACTUAL_BUDGET_ID = 'budget-1';
    process.env.ACTUAL_DATA_DIR = '/tmp/actual-mcp-connection-test';
  });

  afterEach(() => {
    delete process.env.ACTUAL_SERVER_URL;
    delete process.env.ACTUAL_BUDGET_ID;
    delete process.env.ACTUAL_DATA_DIR;
    delete process.env.ACTUAL_PASSWORD;
  });

  it('blames the server, not the password, when nothing is listening', async () => {
    // No ACTUAL_PASSWORD set — the case that used to be misread as an auth
    // failure, sending people to check a password for an hour.
    downloadBudget.mockRejectedValue(networkFailure);
    const { ensureConnection } = await import('../../connection.js');

    await expect(ensureConnection()).rejects.toThrow(/could not (connect|reach)/i);
  });

  it('does not mention the password when the server is unreachable', async () => {
    downloadBudget.mockRejectedValue(networkFailure);
    const { ensureConnection } = await import('../../connection.js');

    await expect(ensureConnection()).rejects.not.toThrow(/ACTUAL_PASSWORD/);
  });

  it('still reports a genuine auth failure as such', async () => {
    process.env.ACTUAL_PASSWORD = 'wrong';
    downloadBudget.mockRejectedValue(new Error('Could not get remote files'));
    const { ensureConnection } = await import('../../connection.js');

    await expect(ensureConnection()).rejects.toThrow(/authentication failed/i);
  });
});
