import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * A budget newer than the library that has to open it (#139).
 *
 * Measured against a 26.10 budget with the 26.9 library: `downloadBudget` does
 * **not** throw. It logs `out-of-sync-migrations` and resolves, so the server
 * believed it had connected and the first tool answered `No budget file is
 * open` — a message about a file, for a version problem, with nothing in the
 * logs the person could act on.
 *
 * The detection added in #72 worked and handed the flag back. Nothing read it,
 * because the only place that looked was a `catch` for an error that is never
 * thrown. These tests hold both routes, since the engine may start propagating
 * it and then the other one is the only one that fires.
 */
vi.mock('../data-dir-lock.js', () => ({
  claimDataDir: () => ({ dataDir: '/tmp/does-not-matter', shared: false, contended: null }),
  releaseDataDir: () => {},
  effectiveDataDir: () => '/tmp/does-not-matter',
  ensureDataDirExists: () => {},
}));

const downloadBudget = vi.fn();
vi.mock('@actual-app/api', () => ({
  init: vi.fn(async () => ({ send: vi.fn() })),
  downloadBudget: (...args: unknown[]) => downloadBudget(...args),
  shutdown: vi.fn(async () => {}),
  sync: vi.fn(async () => {}),
}));

/** What the engine prints on its way to resolving anyway. */
const ENGINE_LOG = 'Error updating Error: out-of-sync-migrations';

describe('a budget newer than the library (#139)', () => {
  let stderr: string[];
  let restore: () => void;

  beforeEach(() => {
    vi.resetModules();
    downloadBudget.mockReset();
    process.env.ACTUAL_SERVER_URL = 'http://127.0.0.1:5099';
    process.env.ACTUAL_BUDGET_ID = 'a-sync-id';
    process.env.ACTUAL_PASSWORD = 'not-a-real-password';
    stderr = [];
    const original = console.error;
    console.error = (...args: unknown[]) => void stderr.push(args.map(String).join(' '));
    restore = () => {
      console.error = original;
    };
  });

  afterEach(() => restore());

  it('says so when the engine resolves instead of throwing', async () => {
    // The route the user actually takes.
    downloadBudget.mockImplementation(async () => {
      console.error(ENGINE_LOG);
    });
    const { ensureConnection } = await import('../../connection.js');

    await expect(ensureConnection()).rejects.toThrow(/newer than the Actual library/);
  });

  it('says so on stderr too, not only in the reply', async () => {
    // The reply reaches the model; stderr is where a person looks. The report
    // said there was nothing in the logs, and there was not.
    downloadBudget.mockImplementation(async () => {
      console.error(ENGINE_LOG);
    });
    const { ensureConnection } = await import('../../connection.js');

    await expect(ensureConnection()).rejects.toThrow();
    const ours = stderr.filter((line) => line.includes('[actual-budget-mcp]'));
    expect(ours.join('\n')).toMatch(/newer than the Actual library/);
  });

  it('names what to do, and does not blame the credentials', async () => {
    downloadBudget.mockImplementation(async () => {
      console.error(ENGINE_LOG);
    });
    const { ensureConnection } = await import('../../connection.js');

    const error = await ensureConnection().catch((e: Error) => e);
    const message = (error as Error).message;
    // The three things the person would otherwise go and check, one at a time.
    expect(message).toMatch(/Nothing is wrong with your password/);
    expect(message).toMatch(/Update actual-budget-mcp|Desktop Extension/);
    // And a way out when they are already on the latest build.
    expect(message).toMatch(/issues/);
    // Never the old message, which named a file.
    expect(message).not.toMatch(/No budget file is open/);
  });

  it('still says so when the engine does throw', async () => {
    // The #72 route. Kept because the engine may start propagating it.
    downloadBudget.mockImplementation(async () => {
      console.error(ENGINE_LOG);
      throw new Error('No budget file is open');
    });
    const { ensureConnection } = await import('../../connection.js');

    await expect(ensureConnection()).rejects.toThrow(/newer than the Actual library/);
  });

  it('leaves an ordinary failure alone', async () => {
    // Without this the guard above could swallow every other error: the check
    // is on the marker, not on downloading having failed.
    downloadBudget.mockImplementation(async () => {
      throw new Error('Could not get remote files');
    });
    const { ensureConnection } = await import('../../connection.js');

    const error = await ensureConnection().catch((e: Error) => e);
    expect((error as Error).message).not.toMatch(/newer than the Actual library/);
  });

  it('connects normally when nothing is out of sync', async () => {
    downloadBudget.mockImplementation(async () => {});
    const { ensureConnection } = await import('../../connection.js');

    await expect(ensureConnection()).resolves.toBeUndefined();
  });
});
