import { describe, it, expect, afterEach, vi } from 'vitest';

/**
 * The diagnostic command and an address it cannot use (#275).
 *
 * `npm run test:connection` is what somebody runs when the server is not
 * answering, and its whole output is what they paste into an issue. It
 * refuses the same addresses the server refuses, before it prints anything
 * about them.
 */

vi.mock('dotenv/config', () => ({}));
vi.mock('../utils/http-timeout.js', () => ({}));
vi.mock('@actual-app/api', () => ({
  default: {},
  init: vi.fn().mockResolvedValue(undefined),
  downloadBudget: vi.fn().mockResolvedValue(undefined),
  getAccounts: vi.fn().mockResolvedValue([]),
  shutdown: vi.fn().mockResolvedValue(undefined),
  utils: {
    amountToInteger: (a: number) => Math.round(a * 100),
    integerToAmount: (c: number) => c / 100,
  },
}));
vi.mock('../utils/data-dir-lock.js', () => ({
  effectiveDataDir: () => '/tmp/nowhere',
  ensureDataDirExists: vi.fn(),
}));

class Exited extends Error {
  constructor(readonly code: number) {
    super(`exit ${code}`);
  }
}

async function run(): Promise<{ exit?: number; said: string }> {
  const lines: string[] = [];
  const record = (...args: unknown[]) => {
    lines.push(args.map(String).join(' '));
  };
  const exit = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new Exited(code ?? 0);
  }) as never);
  const out = vi.spyOn(console, 'log').mockImplementation(record);
  const err = vi.spyOn(console, 'error').mockImplementation(record);
  try {
    const { testConnection } = await import('../test-connection.js');
    await testConnection();
    return { said: lines.join('\n') };
  } catch (error) {
    if (error instanceof Exited) return { exit: error.code, said: lines.join('\n') };
    throw error;
  } finally {
    exit.mockRestore();
    out.mockRestore();
    err.mockRestore();
  }
}

describe('the connection test command', () => {
  afterEach(() => {
    delete process.env.ACTUAL_SERVER_URL;
    delete process.env.ACTUAL_BUDGET_ID;
  });

  it('refuses an address with credentials before printing it', async () => {
    process.env.ACTUAL_SERVER_URL = 'http://user:hunter2@actual.example:5006';
    process.env.ACTUAL_BUDGET_ID = 'budget-1';

    const { exit, said } = await run();

    expect(exit).toBe(1);
    expect(said).toContain('cannot work');
    expect(said).not.toContain('hunter2');
  });

  it('refuses an address that does not parse without repeating it', async () => {
    process.env.ACTUAL_SERVER_URL = 'http://user:hunter2/two@203.0.113.9:5006';
    process.env.ACTUAL_BUDGET_ID = 'budget-1';

    const { exit, said } = await run();

    expect(exit).toBe(1);
    expect(said).not.toContain('hunter2');
    expect(said).not.toContain('203.0.113.9');
  });
});
