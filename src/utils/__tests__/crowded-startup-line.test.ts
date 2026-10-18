import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * That the server actually says it (#207).
 *
 * The text and its tests can both be right while nothing prints it, and then
 * the startup line goes back to naming one directory and one pid while six
 * servers run against the same budget. So this drives the connection and
 * reads what it wrote to stderr.
 */
const claim = {
  dataDir: '/data/actual-budget-mcp-4',
  contended: '/data/actual-budget-mcp',
  heldBy: { pid: 111, startedAt: '2001-01-01T00:00:00.000Z', version: '0.0.0' },
  others: [
    { pid: 111, startedAt: '2001-01-01T00:00:00.000Z', version: '0.0.0' },
    { pid: 222, startedAt: '2001-02-02T00:00:00.000Z', version: '0.0.0' },
    { pid: 333, startedAt: '2001-03-03T00:00:00.000Z', version: '0.0.0' },
  ],
  shared: false,
};

vi.mock('../data-dir-lock.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../data-dir-lock.js')>()),
  claimDataDir: () => claim,
  effectiveDataDir: () => claim.contended,
  ensureDataDirExists: () => {},
  releaseDataDirLock: () => {},
}));

vi.mock('@actual-app/api', () => ({
  init: vi.fn(async () => ({ send: vi.fn() })),
  downloadBudget: vi.fn(async () => {}),
  getBudgetMonths: vi.fn(async () => ['2026-10']),
  getServerVersion: vi.fn(async () => ({ version: '26.10.0' })),
  shutdown: vi.fn(async () => {}),
  sync: vi.fn(async () => {}),
}));

describe('what the server says when it is not on the first directory', () => {
  let stderr: string[];
  let restore: () => void;

  beforeEach(() => {
    vi.resetModules();
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

  afterEach(() => {
    restore();
    delete process.env.ACTUAL_SERVER_URL;
    delete process.env.ACTUAL_BUDGET_ID;
    delete process.env.ACTUAL_PASSWORD;
  });

  it('counts the others and says what it costs', async () => {
    const { ensureConnection } = await import('../../connection.js');

    await ensureConnection();
    const line = stderr.find((l) => l.includes('servers are running'));

    expect(line, 'nothing printed it').toBeDefined();
    expect(line).toContain('4 actual-budget-mcp servers');
    expect(line).toContain('The oldest started on 2001-01-01.');
    expect(line).toContain('full download on disk');
    expect(line, 'the fix is closing them, not a list to go killing').not.toMatch(/pid/i);
  });
});
