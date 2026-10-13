import { describe, it, expect, vi, beforeEach } from 'vitest';

// Everything real except the engine and the connection. What is observable
// from outside the wrapper is whether the preference was read, so that is what
// this asks about: stubbing `refreshBudgetDecimalPlaces` would not work, since
// mocking a module's export does not change the calls made inside that module.
vi.mock('@actual-app/api', () => ({
  sync: vi.fn().mockResolvedValue(undefined),
  getAccounts: vi.fn().mockResolvedValue([]),
  getCategoryGroups: vi.fn().mockResolvedValue([]),
  getCategories: vi.fn().mockResolvedValue([]),
  getPayees: vi.fn().mockResolvedValue([]),
  getRules: vi.fn().mockResolvedValue([]),
  getAccountBalance: vi.fn().mockResolvedValue(0),
  getBudgetMonths: vi.fn().mockResolvedValue([]),
  runQuery: vi.fn().mockResolvedValue({ data: [] }),
  q: vi.fn(() => ({ filter: () => ({ select: () => ({}) }), select: () => ({}) })),
  aqlQuery: vi.fn().mockResolvedValue({ data: [] }),
  utils: {
    amountToInteger: (a: number, places = 2) => Math.round(a * Math.pow(10, places)),
    integerToAmount: (c: number, places = 2) => c / Math.pow(10, places),
  },
}));

const send = vi.fn();
vi.mock('../../connection.js', () => ({
  ensureConnection: vi.fn().mockResolvedValue(undefined),
  getInternal: () => ({ send: (...a: unknown[]) => send(...a) }),
}));

import { registerAllTools } from '../index.js';
import { resetSyncState } from '../../utils/read-sync.js';
import { resetBudgetDecimalPlaces } from '../../utils/currency.js';

interface Registered {
  name: string;
  readOnly: boolean;
  handler: (args: unknown) => Promise<unknown>;
}

function registerAndCollect(): Registered[] {
  const tools: Registered[] = [];
  const server = {
    tool: (...args: unknown[]) => {
      const annotations = args.find(
        (a): a is { readOnlyHint?: boolean } =>
          typeof a === 'object' && a !== null && 'readOnlyHint' in a,
      );
      tools.push({
        name: String(args[0]),
        readOnly: annotations?.readOnlyHint === true,
        handler: args[args.length - 1] as Registered['handler'],
      });
    },
  };
  registerAllTools(server as never);
  return tools;
}

/**
 * Every write tool re-reads the budget currency on the way in (#141).
 *
 * The wrapper and the module both have their own tests, and both of them pass
 * with the wrapper never applied: `withReadSync(withCurrentCurrency(server))`
 * can be edited down to `withReadSync(server)` without a single failure
 * elsewhere, because the default count is right for most currencies. This is
 * the test that falls over when that happens, and it goes through
 * `registerAllTools`, which is the server the process actually builds.
 */
describe('the registered server re-reads the currency before writing', () => {
  beforeEach(() => {
    resetSyncState();
    resetBudgetDecimalPlaces();
    send.mockReset().mockResolvedValue({ defaultCurrencyCode: 'JPY' });
  });

  /** Which preference reads happened while running `handler`. */
  async function preferenceReadsDuring(tool: Registered): Promise<number> {
    send.mockClear();
    try {
      await tool.handler({});
    } catch {
      // The handler itself is free to fail: it is being called with no
      // arguments against a stubbed engine. The wrapper runs before it, and
      // the call is what is being counted.
    }
    return send.mock.calls.filter((c) => c[0] === 'preferences/get').length;
  }

  it('reads it in every tool that writes', async () => {
    const tools = registerAndCollect();
    const writes = tools.filter((t) => !t.readOnly);
    expect(writes.length, 'no write tools were registered at all').toBeGreaterThan(10);

    const missing: string[] = [];
    for (const tool of writes) {
      if ((await preferenceReadsDuring(tool)) === 0) missing.push(tool.name);
    }

    expect(missing, 'these write tools convert amounts with whatever count was left over').toEqual(
      [],
    );
  });

  it('does not read it twice in a tool that only reads', async () => {
    // Reads refresh through the sync instead, so a second query per read
    // would be for the same answer.
    const tools = registerAndCollect();
    const read = tools.find((t) => t.readOnly && t.name === 'list_accounts');
    expect(read, 'list_accounts is not registered as read-only any more').toBeDefined();

    // The sync path reads it once, through `syncNow`. What must not happen is
    // the wrapper adding another on top.
    expect(await preferenceReadsDuring(read!)).toBeLessThanOrEqual(1);
  });
});
