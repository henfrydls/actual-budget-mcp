import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const init = vi.fn();
const downloadBudget = vi.fn();
const apiShutdown = vi.fn();
vi.mock('@actual-app/api', () => ({
  init: (...a: unknown[]) => init(...a),
  downloadBudget: (...a: unknown[]) => downloadBudget(...a),
  getBudgetMonths: vi.fn(async () => ['2026-10']),
  getServerVersion: vi.fn(async () => ({ version: '26.10.0' })),
  shutdown: (...a: unknown[]) => apiShutdown(...a),
  sync: vi.fn(async () => {}),
}));

vi.mock('../data-dir-lock.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../data-dir-lock.js')>()),
  claimDataDir: () => ({ dataDir: '/tmp/does-not-matter', shared: false }),
  effectiveDataDir: () => '/tmp/does-not-matter',
  ensureDataDirExists: () => {},
  releaseDataDirLock: () => {},
}));

/**
 * Leaving while the budget is still opening (#219).
 *
 * The first download takes minutes and `initialized` is only set at the end
 * of it, but `api.init` has signed in long before: from Actual 26.11 that is
 * a session row on the server with `expires_at = -1`, which only
 * `api.shutdown()` clears. Measured against a disposable 26.11 server:
 * ending stdin during startup left one behind every time, because shutdown
 * read `initialized` as false and decided there was nothing to close.
 */
describe('shutting down while the connection is still being made', () => {
  beforeEach(() => {
    vi.resetModules();
    init.mockReset().mockResolvedValue({ send: vi.fn() });
    apiShutdown.mockReset().mockResolvedValue(undefined);
    process.env.ACTUAL_SERVER_URL = 'http://127.0.0.1:5099';
    process.env.ACTUAL_BUDGET_ID = 'a-sync-id';
    process.env.ACTUAL_PASSWORD = 'not-a-real-password';
  });

  afterEach(() => {
    delete process.env.ACTUAL_SERVER_URL;
    delete process.env.ACTUAL_BUDGET_ID;
    delete process.env.ACTUAL_PASSWORD;
  });

  it('waits for it and then closes the session it opened', async () => {
    let finishDownload: (() => void) | undefined;
    downloadBudget.mockImplementation(
      () => new Promise<void>((resolve) => { finishDownload = () => resolve(); }),
    );
    const { ensureConnection, shutdown } = await import('../../connection.js');

    const connecting = ensureConnection();
    await vi.waitFor(() => expect(downloadBudget).toHaveBeenCalled());

    // The client goes away here, with the download still running.
    const leaving = shutdown();
    finishDownload!();
    await connecting;
    await leaving;

    expect(apiShutdown, 'the session this process opened is still open').toHaveBeenCalledOnce();
  });

  it('still does nothing when there was never a connection', async () => {
    const { shutdown } = await import('../../connection.js');

    await shutdown();

    expect(apiShutdown).not.toHaveBeenCalled();
  });

  it('does not hold the exit open when the connection fails', async () => {
    downloadBudget.mockRejectedValue(new Error('the server is not there'));
    const { ensureConnection, shutdown } = await import('../../connection.js');

    const connecting = ensureConnection().catch(() => undefined);
    await vi.waitFor(() => expect(downloadBudget).toHaveBeenCalled());

    await expect(shutdown()).resolves.toBeUndefined();
    await connecting;
  });

  it('closes the session of each startup that failed, not only the last', async () => {
    // Every call that fails tries again and signs in again. Measured
    // against a disposable server whose download was cut: three calls took
    // the session count from 20 to 26, and leaving closed one of them.
    downloadBudget.mockRejectedValue(new Error('the download was cut'));
    const { ensureConnection } = await import('../../connection.js');

    await ensureConnection().catch(() => undefined);
    await ensureConnection().catch(() => undefined);
    await ensureConnection().catch(() => undefined);

    expect(apiShutdown, 'one close per sign-in that failed').toHaveBeenCalledTimes(3);
  });

  it('still reports the failure after closing the session', async () => {
    downloadBudget.mockRejectedValue(new Error('the download was cut'));
    const { ensureConnection } = await import('../../connection.js');

    await expect(ensureConnection()).rejects.toThrow();
  });

  it('closes the session of a startup that signed in and then failed', async () => {
    // `initialized` is only true once the budget is open, so a download that
    // fails left a session on the server and a claimed directory with
    // nothing to give either of them back.
    downloadBudget.mockRejectedValue(new Error('the server went away mid-download'));
    const { ensureConnection, shutdown } = await import('../../connection.js');

    await ensureConnection().catch(() => undefined);
    await shutdown();

    expect(apiShutdown, 'it signed in, so there is a session to close').toHaveBeenCalledOnce();
  });
});
