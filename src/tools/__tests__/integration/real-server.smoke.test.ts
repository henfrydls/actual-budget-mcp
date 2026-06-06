import { describe, it, expect, beforeAll, afterAll } from 'vitest';

/**
 * READ-ONLY smoke test against a REAL Actual server (e.g. your own).
 *
 * This NEVER writes: it only lists accounts and reads transactions, so it cannot
 * affect your data. It is opt-in and skipped unless you explicitly enable it:
 *
 *   ACTUAL_SMOKE=1 \
 *   ACTUAL_SERVER_URL=http://localhost:5006 \
 *   ACTUAL_PASSWORD=... \
 *   ACTUAL_BUDGET_ID=<your sync id> \
 *   npm test -- real-server.smoke
 *
 * Use your real budget id for a confidence check, or a dedicated throwaway
 * budget if you prefer maximum isolation.
 */

const enabled =
  process.env.ACTUAL_SMOKE === '1' &&
  !!process.env.ACTUAL_SERVER_URL &&
  !!process.env.ACTUAL_BUDGET_ID;

describe.skipIf(!enabled)('real server smoke (read-only)', () => {
  let ensureConnection: typeof import('../../../connection.js').ensureConnection;
  let shutdown: typeof import('../../../connection.js').shutdown;
  let getTransactionsReport: typeof import('../../read/get-transactions.js').getTransactionsReport;
  let api: typeof import('@actual-app/api');

  beforeAll(async () => {
    // Import lazily so the unmocked real connection is only used when enabled.
    ({ ensureConnection, shutdown } = await import('../../../connection.js'));
    ({ getTransactionsReport } = await import('../../read/get-transactions.js'));
    api = await import('@actual-app/api');
    await ensureConnection();
  }, 120_000);

  afterAll(async () => {
    if (shutdown) await shutdown();
  });

  it('lists at least one account', async () => {
    const accounts = await api.getAccounts();
    expect(Array.isArray(accounts)).toBe(true);
    expect(accounts.length).toBeGreaterThan(0);
  });

  it('renders a transactions report including the Cleared column', async () => {
    const text = await getTransactionsReport({ start_date: 'start of month' });
    // Either there are transactions (table with Cleared) or a friendly empty message.
    if (!text.startsWith('No transactions found')) {
      expect(text).toContain('Cleared');
    }
  });
});
