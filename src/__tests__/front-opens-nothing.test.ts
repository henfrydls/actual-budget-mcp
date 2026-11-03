import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// The engine, so that nothing reaches a network. Not the connection: what
// this file is about is whether the front end opens a budget, and
// `ensureConnection` is the thing that would. It claims the data directory
// before it touches the network, so the lock file is the evidence.
vi.mock('@actual-app/api', () => ({
  default: {},
  init: vi.fn(async () => ({ send: vi.fn() })),
  downloadBudget: vi.fn(async () => {}),
  getBudgetMonths: vi.fn(async () => ['2026-01']),
  getBudgets: vi.fn(async () => []),
  getAccounts: vi.fn(async () => []),
  getServerVersion: vi.fn(async () => undefined),
  shutdown: vi.fn(async () => {}),
  sync: vi.fn(async () => {}),
  utils: {
    amountToInteger: (a: number) => Math.round(a * 100),
    integerToAmount: (c: number) => c / 100,
  },
}));

import { registerAllTools } from '../tools/index.js';
import { registerAllResources } from '../resources.js';
import { usePool } from '../workers/current.js';

const VARS = [
  'ACTUAL_BUDGET_ID',
  'ACTUAL_BUDGET_IDS',
  'ACTUAL_DATA_DIR',
  'ACTUAL_SERVER_URL',
  'ACTUAL_PASSWORD',
];

type Handler = (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }>;

/**
 * The front end opens no budget (#229).
 *
 * Every wrapper runs before the handler it wraps, and the handler that
 * routes is installed by `withBudgetId`, so the wrappers that sync, re-read
 * the currency and open a budget used to run first, in this process, on
 * ACTUAL_BUDGET_ID, for a call meant for another budget. Measured: a read
 * routed to the second budget left `.actual-mcp-lock.json` and a downloaded
 * copy in the data directory, next to the worker's own.
 */
describe('a front end that routes', () => {
  afterEach(() => {
    for (const name of VARS) delete process.env[name];
    usePool(undefined);
    vi.clearAllMocks();
  });

  function tools(): Map<string, Handler> {
    const found = new Map<string, Handler>();
    registerAllTools({
      tool: (...args: unknown[]) => {
        if (typeof args[0] === 'string') found.set(args[0], args.at(-1) as Handler);
      },
    } as never);
    return found;
  }

  it('leaves the data directory untouched when it routes a read', async () => {
    const dataDir = mkdtempSync(path.join(os.tmpdir(), 'actual-mcp-front-'));
    process.env.ACTUAL_DATA_DIR = dataDir;
    process.env.ACTUAL_SERVER_URL = 'http://127.0.0.1:1';
    process.env.ACTUAL_PASSWORD = 'not-a-real-password';
    process.env.ACTUAL_BUDGET_ID = 'bud-a';
    process.env.ACTUAL_BUDGET_IDS = 'bud-a,bud-b';
    const routed: Array<{ budgetId: string }> = [];
    usePool({
      call: async (budgetId: string) => {
        routed.push({ budgetId });
        return { content: [{ type: 'text', text: `answered by ${budgetId}` }] };
      },
      openBudgets: () => [],
      stop: async () => undefined,
    } as never);

    const reply = await tools().get('get_budget_month')!({ budget_id: 'bud-b', month: '2026-01' });

    expect(reply.content[0].text).toContain('bud-b');
    expect(routed).toEqual([{ budgetId: 'bud-b' }]);
    // No lock, no budget directory, nothing: the front end did not open a
    // budget of its own on the way to routing a call for another one.
    expect(readdirSync(dataDir)).toEqual([]);
  }, 30_000);

  it('leaves it untouched on a write as well', async () => {
    const dataDir = mkdtempSync(path.join(os.tmpdir(), 'actual-mcp-front-'));
    process.env.ACTUAL_DATA_DIR = dataDir;
    process.env.ACTUAL_SERVER_URL = 'http://127.0.0.1:1';
    process.env.ACTUAL_PASSWORD = 'not-a-real-password';
    process.env.ACTUAL_BUDGET_ID = 'bud-a';
    process.env.ACTUAL_BUDGET_IDS = 'bud-a,bud-b';
    usePool({
      call: async (budgetId: string) => ({
        content: [{ type: 'text', text: `written in ${budgetId}` }],
      }),
      openBudgets: () => [],
      stop: async () => undefined,
    } as never);

    const reply = await tools().get('create_transaction')!({
      budget_id: 'bud-b',
      account: 'Checking',
      amount: -12.5,
      date: '2026-01-05',
    });

    expect(reply.content[0].text).toContain('bud-b');
    expect(readdirSync(dataDir)).toEqual([]);
  }, 30_000);

  it('offers no resources, because a URI does not say which budget', async () => {
    process.env.ACTUAL_BUDGET_ID = 'bud-a';
    process.env.ACTUAL_BUDGET_IDS = 'bud-a,bud-b';
    const registered: string[] = [];
    registerAllResources({
      tool: () => undefined,
      resource: (name: string) => registered.push(name),
    } as never);

    expect(registered).toEqual([]);
  });

  it('offers them again when it serves one budget', async () => {
    process.env.ACTUAL_BUDGET_ID = 'bud-a';
    const registered: string[] = [];
    registerAllResources({
      tool: () => undefined,
      resource: (name: string) => registered.push(name),
    } as never);

    expect(registered.length).toBeGreaterThan(0);
  });
});
