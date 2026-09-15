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

  it('suggests the desktop app port when 5006 is unreachable', async () => {
    process.env.ACTUAL_SERVER_URL = 'http://localhost:5006';
    downloadBudget.mockRejectedValue(networkFailure);
    const { ensureConnection } = await import('../../connection.js');

    await expect(ensureConnection()).rejects.toThrow(/5007/);
  });

  it('explains that 5007 only answers while the desktop app is open', async () => {
    process.env.ACTUAL_SERVER_URL = 'http://localhost:5007';
    downloadBudget.mockRejectedValue(networkFailure);
    const { ensureConnection } = await import('../../connection.js');

    await expect(ensureConnection()).rejects.toThrow(/while the app is open/i);
  });

  it('adds no port advice for a URL that is neither', async () => {
    process.env.ACTUAL_SERVER_URL = 'https://budget.example.com';
    downloadBudget.mockRejectedValue(networkFailure);
    const { ensureConnection } = await import('../../connection.js');

    await expect(ensureConnection()).rejects.not.toThrow(/500[67]/);
  });

  it('still reports a genuine auth failure as such', async () => {
    process.env.ACTUAL_PASSWORD = 'wrong';
    downloadBudget.mockRejectedValue(new Error('Could not get remote files'));
    const { ensureConnection } = await import('../../connection.js');

    await expect(ensureConnection()).rejects.toThrow(/authentication failed/i);
  });
});

/**
 * The shape @actual-app/api actually throws. Its `withErrorCode` helper tags
 * errors with `code`, not `reason`, and the message it puts on an unreachable
 * server opens with the words "Authentication failed" — so an error that is
 * purely about connectivity reads as a rejected password unless we reclassify
 * it. Henfry hit exactly this on macOS with the SSH tunnel closed.
 */
const sdkOffline = () =>
  Object.assign(new Error('Authentication failed: server offline or unreachable'), {
    code: 'network-failure',
  });

describe('a network failure never reads as an authentication failure', () => {
  beforeEach(() => {
    vi.resetModules();
    init.mockReset().mockResolvedValue({ send: vi.fn() });
    downloadBudget.mockReset().mockResolvedValue(undefined);
    process.env.ACTUAL_SERVER_URL = 'http://localhost:5007';
    process.env.ACTUAL_BUDGET_ID = 'budget-1';
    process.env.ACTUAL_DATA_DIR = '/tmp/actual-mcp-connection-test';
  });

  afterEach(() => {
    delete process.env.ACTUAL_SERVER_URL;
    delete process.env.ACTUAL_BUDGET_ID;
    delete process.env.ACTUAL_DATA_DIR;
    delete process.env.ACTUAL_PASSWORD;
    delete process.env.ACTUAL_SESSION_TOKEN;
  });

  it('does not repeat the SDK words "Authentication failed" when init cannot reach the server', async () => {
    init.mockRejectedValue(sdkOffline());
    const { ensureConnection } = await import('../../connection.js');

    await expect(ensureConnection()).rejects.not.toThrow(/authentication failed/i);
  });

  it('says it could not reach the server, and names it', async () => {
    init.mockRejectedValue(sdkOffline());
    const { ensureConnection } = await import('../../connection.js');

    await expect(ensureConnection()).rejects.toThrow(/could not (connect|reach)/i);
    await expect(ensureConnection()).rejects.toThrow(/localhost:5007/);
  });

  it('gives the same port advice from init as from the budget download', async () => {
    init.mockRejectedValue(sdkOffline());
    const { ensureConnection } = await import('../../connection.js');

    await expect(ensureConnection()).rejects.toThrow(/while the app is open/i);
  });

  it('reads the code the SDK sets when the budget download fails', async () => {
    downloadBudget.mockRejectedValue(
      Object.assign(new Error('Authentication failed: server offline or unreachable'), {
        code: 'network-failure',
      }),
    );
    const { ensureConnection } = await import('../../connection.js');

    await expect(ensureConnection()).rejects.not.toThrow(/authentication failed/i);
  });

  it('still treats an expired token as a token problem, not a network one', async () => {
    process.env.ACTUAL_SESSION_TOKEN = 'stale';
    init.mockRejectedValue(
      Object.assign(new Error('Authentication failed: invalid or expired session token'), {
        code: 'token-expired',
      }),
    );
    const { ensureConnection } = await import('../../connection.js');

    await expect(ensureConnection()).rejects.toThrow(/session token/i);
  });
});
