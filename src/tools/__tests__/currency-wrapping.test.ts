import { describe, it, expect, vi, beforeEach } from 'vitest';

// Everything real except the engine and the connection. What is observable
// from outside the wrapper is whether the preference was read, so that is what
// this asks about: stubbing `refreshBudgetDecimalPlaces` would not work, since
// mocking a module's export does not change the calls made inside that module.
/**
 * Everything the tools touch, in the order they touch it.
 *
 * The order is the point. Counting reads is not enough:
 * `transfer_between_categories` reads `preferences/get` itself, for the note
 * the engine writes, and it does that after converting the amount. A test
 * that only counts would see that read and call the tool covered while the
 * conversion it is there to protect had already happened with the old count.
 */
// `vi.hoisted`, because a `vi.mock` factory is lifted above everything else in
// the file and cannot see an ordinary top-level variable.
const { touched, record } = vi.hoisted(() => {
  const seen: string[] = [];
  return {
    touched: seen,
    record:
      <T>(name: string, result: T) =>
      async () => {
        seen.push(name);
        return result;
      },
  };
});

vi.mock('@actual-app/api', () => ({
  sync: record('sync', undefined),
  getAccounts: record('getAccounts', []),
  getCategoryGroups: record('getCategoryGroups', []),
  getCategories: record('getCategories', []),
  getPayees: record('getPayees', []),
  getRules: record('getRules', []),
  getAccountBalance: record('getAccountBalance', 0),
  getBudgetMonths: record('getBudgetMonths', []),
  getBudgetMonth: record('getBudgetMonth', { categoryGroups: [] }),
  runQuery: record('runQuery', { data: [] }),
  aqlQuery: record('aqlQuery', { data: [] }),
  q: vi.fn(() => ({ filter: () => ({ select: () => ({}) }), select: () => ({}) })),
  utils: {
    amountToInteger: (a: number, places = 2) => Math.round(a * Math.pow(10, places)),
    integerToAmount: (c: number, places = 2) => c / Math.pow(10, places),
  },
}));

const send = vi.fn();
vi.mock('../../connection.js', () => ({
  ensureConnection: vi.fn().mockResolvedValue(undefined),
  getInternal: () => ({
    send: (...a: unknown[]) => {
      touched.push(`send:${String(a[0])}`);
      return send(...a);
    },
  }),
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

  /** Everything the tool touched in the engine, in order. */
  async function engineCallsOf(tool: Registered): Promise<string[]> {
    touched.length = 0;
    try {
      await tool.handler({});
    } catch {
      // The handler itself is free to fail: it is being called with no
      // arguments against a stubbed engine. The wrapper runs before it, and
      // what is being recorded is what the tool reached for first.
    }
    return [...touched];
  }

  it('reads it first in every tool that writes, before anything is converted', async () => {
    const tools = registerAndCollect();
    const writes = tools.filter((t) => !t.readOnly);
    expect(writes.length, 'no write tools were registered at all').toBeGreaterThan(10);

    const late: string[] = [];
    for (const tool of writes) {
      // First, not merely present. A tool that reads the preference somewhere
      // in the middle of its work has already converted its amount by then,
      // which is the case this exists to catch rather than the case it looks
      // like it catches.
      if ((await engineCallsOf(tool))[0] !== 'send:preferences/get') late.push(tool.name);
    }

    expect(late, 'these write tools convert amounts before re-reading the currency').toEqual([]);
  });

  it('does not add a read of its own to a tool that only reads', async () => {
    // Reads refresh through the sync instead, so a second query per read
    // would be for the same answer.
    const tools = registerAndCollect();
    const read = tools.find((t) => t.readOnly && t.name === 'list_accounts');
    expect(read, 'list_accounts is not registered as read-only any more').toBeDefined();

    const calls = await engineCallsOf(read!);
    expect(calls.filter((c) => c === 'send:preferences/get').length).toBeLessThanOrEqual(1);
  });
});
