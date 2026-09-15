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

/**
 * Actual servers behind OIDC have no password to put in ACTUAL_PASSWORD — they
 * issue a session token instead (actualbudget/actual#8721). The SDK already
 * accepts one; the server just never passed it through.
 */
describe('session token authentication (OIDC servers)', () => {
  beforeEach(() => {
    vi.resetModules();
    init.mockReset().mockResolvedValue({ send: vi.fn() });
    downloadBudget.mockReset().mockResolvedValue(undefined);
    process.env.ACTUAL_SERVER_URL = 'http://localhost:5006';
    process.env.ACTUAL_BUDGET_ID = 'budget-1';
    process.env.ACTUAL_DATA_DIR = '/tmp/actual-mcp-token-test';
  });

  afterEach(() => {
    for (const k of [
      'ACTUAL_SERVER_URL',
      'ACTUAL_BUDGET_ID',
      'ACTUAL_DATA_DIR',
      'ACTUAL_PASSWORD',
      'ACTUAL_SESSION_TOKEN',
    ]) {
      delete process.env[k];
    }
  });

  it('passes the session token to the SDK', async () => {
    process.env.ACTUAL_SESSION_TOKEN = 'tok-abc';
    const { ensureConnection } = await import('../../connection.js');

    await ensureConnection();

    expect(init.mock.calls[0][0]).toMatchObject({ sessionToken: 'tok-abc' });
  });

  it('does not send an empty password alongside a token', async () => {
    process.env.ACTUAL_SESSION_TOKEN = 'tok-abc';
    const { ensureConnection } = await import('../../connection.js');

    await ensureConnection();

    expect(init.mock.calls[0][0]).not.toHaveProperty('password');
  });

  it('still uses the password when there is no token', async () => {
    process.env.ACTUAL_PASSWORD = 'hunter2';
    const { ensureConnection } = await import('../../connection.js');

    await ensureConnection();

    expect(init.mock.calls[0][0]).toMatchObject({ password: 'hunter2' });
    expect(init.mock.calls[0][0]).not.toHaveProperty('sessionToken');
  });

  it('prefers the token when both are set, rather than silently picking one', async () => {
    process.env.ACTUAL_PASSWORD = 'hunter2';
    process.env.ACTUAL_SESSION_TOKEN = 'tok-abc';
    const { ensureConnection } = await import('../../connection.js');

    await ensureConnection();

    expect(init.mock.calls[0][0]).toMatchObject({ sessionToken: 'tok-abc' });
  });

  it('explains an expired token instead of blaming the password', async () => {
    process.env.ACTUAL_SESSION_TOKEN = 'tok-old';
    init.mockRejectedValue(
      Object.assign(new Error('Authentication failed: invalid or expired session token'), {
        reason: 'token-expired',
      }),
    );
    const { ensureConnection } = await import('../../connection.js');

    await expect(ensureConnection()).rejects.toThrow(/ACTUAL_SESSION_TOKEN/);
    await expect(ensureConnection()).rejects.toThrow(/expired|new token/i);
  });

  it('does not mention the password when a token expired', async () => {
    process.env.ACTUAL_SESSION_TOKEN = 'tok-old';
    init.mockRejectedValue(
      Object.assign(new Error('Authentication failed: invalid or expired session token'), {
        reason: 'token-expired',
      }),
    );
    const { ensureConnection } = await import('../../connection.js');

    await expect(ensureConnection()).rejects.not.toThrow(/ACTUAL_PASSWORD/);
  });
});

/**
 * The failure Henfry hit on macOS with the Desktop Extension. He left the
 * optional session token field empty and filled in his password; Claude Desktop
 * still set ACTUAL_SESSION_TOKEN, to the literal placeholder from the manifest.
 * The server sent it as a token, the token lost to nothing, and the error told
 * him to renew a token he had never created.
 */
describe('an optional field the host left unsubstituted', () => {
  const PLACEHOLDER = '${user_config.session_token}';

  beforeEach(() => {
    vi.resetModules();
    init.mockReset().mockResolvedValue({ send: vi.fn() });
    downloadBudget.mockReset().mockResolvedValue(undefined);
    process.env.ACTUAL_SERVER_URL = 'http://localhost:5007';
    process.env.ACTUAL_BUDGET_ID = 'budget-1';
    process.env.ACTUAL_DATA_DIR = '/tmp/actual-mcp-placeholder-test';
  });

  afterEach(() => {
    for (const k of [
      'ACTUAL_SERVER_URL',
      'ACTUAL_BUDGET_ID',
      'ACTUAL_DATA_DIR',
      'ACTUAL_PASSWORD',
      'ACTUAL_SESSION_TOKEN',
      'ACTUAL_ENCRYPTION_PASSWORD',
    ]) {
      delete process.env[k];
    }
  });

  it('uses the password, and never sends the placeholder as a token', async () => {
    process.env.ACTUAL_SESSION_TOKEN = PLACEHOLDER;
    process.env.ACTUAL_PASSWORD = 'the-real-password';
    const { ensureConnection } = await import('../../connection.js');

    await ensureConnection();

    expect(init.mock.calls[0][0]).toMatchObject({ password: 'the-real-password' });
    expect(init.mock.calls[0][0]).not.toHaveProperty('sessionToken');
  });

  it('does not send a placeholder encryption password to the budget download', async () => {
    process.env.ACTUAL_PASSWORD = 'the-real-password';
    process.env.ACTUAL_ENCRYPTION_PASSWORD = '${user_config.encryption_password}';
    const { ensureConnection } = await import('../../connection.js');

    await ensureConnection();

    expect(downloadBudget.mock.calls[0][1]).toMatchObject({ password: undefined });
  });

  it('still prefers a real token over a password', async () => {
    process.env.ACTUAL_SESSION_TOKEN = 'tok-real';
    process.env.ACTUAL_PASSWORD = 'also-set';
    const { ensureConnection } = await import('../../connection.js');

    await ensureConnection();

    expect(init.mock.calls[0][0]).toMatchObject({ sessionToken: 'tok-real' });
  });
});
