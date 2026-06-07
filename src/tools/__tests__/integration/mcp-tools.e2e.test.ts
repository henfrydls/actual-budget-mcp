import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

// Real engine; only api.sync() neutralized (server-less mode).
vi.mock('@actual-app/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@actual-app/api')>();
  return { ...actual, sync: vi.fn().mockResolvedValue(undefined) };
});

vi.mock('../../../connection.js', () => ({
  ensureConnection: vi.fn().mockResolvedValue(undefined),
}));

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { initTestEngine, shutdownTestEngine, createFreshBudget, api } from './actual-engine.js';
import { registerCreateSplitTransaction } from '../../write/create-split-transaction.js';
import { registerUpdateTransaction } from '../../write/update-transaction.js';
import { registerReconcileCurrencyResidual } from '../../write/reconcile-currency-residual.js';

const skip = process.env.SKIP_ACTUAL_INTEGRATION === '1';

// Drives the tools through the real MCP registration + protocol path (zod input
// schemas, tool dispatch, content/error formatting) — the wrapper layer that the
// per-function tests bypass.
describe.skipIf(skip)('MCP tool wrapper E2E (#28/#25/#30 through the protocol)', () => {
  let client: Client;

  async function call(name: string, args: Record<string, unknown>) {
    return client.callTool({ name, arguments: args }) as Promise<{
      content: Array<{ type: string; text: string }>;
      isError?: boolean;
    }>;
  }

  beforeAll(async () => {
    await initTestEngine();

    const server = new McpServer({ name: 'test', version: '0.0.0' });
    registerCreateSplitTransaction(server);
    registerUpdateTransaction(server);
    registerReconcileCurrencyResidual(server);

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: 'test-client', version: '0.0.0' });
    await server.connect(serverTransport);
    await client.connect(clientTransport);
  }, 60_000);

  afterAll(async () => {
    await shutdownTestEngine();
  });

  it('create_split_transaction works through the protocol and persists', async () => {
    let acctId = '';
    await createFreshBudget(async () => {
      acctId = await api.createAccount({ name: 'Checking', type: 'checking' } as any, 0);
      const g = await api.createCategoryGroup({ name: 'G' } as any);
      await api.createCategory({ name: 'Groceries', group_id: g } as any);
      await api.createCategory({ name: 'Cleaning', group_id: g } as any);
    });

    const res = await call('create_split_transaction', {
      account: 'Checking',
      amount: -150,
      date: '2026-06-05',
      payee: 'Warehouse Club',
      splits: [
        { category: 'Groceries', amount: -90 },
        { category: 'Cleaning', amount: -60 },
      ],
    });

    expect(res.isError).toBeFalsy();
    expect(res.content[0].text).toContain('Split transaction created');

    const parent = (await api.getTransactions(acctId, '2026-06-05', '2026-06-05')).find((t: any) => t.is_parent);
    expect((parent as any).amount).toBe(-15000);
    expect((parent as any).subtransactions).toHaveLength(2);
  }, 60_000);

  it('returns a tool error (not a throw) when splits do not sum to the total', async () => {
    await createFreshBudget(async () => {
      await api.createAccount({ name: 'Checking', type: 'checking' } as any, 0);
      const g = await api.createCategoryGroup({ name: 'G' } as any);
      await api.createCategory({ name: 'Groceries', group_id: g } as any);
      await api.createCategory({ name: 'Cleaning', group_id: g } as any);
    });

    const res = await call('create_split_transaction', {
      account: 'Checking',
      amount: -150,
      splits: [
        { category: 'Groceries', amount: -90 },
        { category: 'Cleaning', amount: -40 },
      ],
    });

    expect(res.isError).toBe(true);
    expect(res.content[0].text.toLowerCase()).toContain('sum');
  }, 60_000);

  it('rejects invalid input via the zod schema (fewer than two splits)', async () => {
    await createFreshBudget(async () => {
      await api.createAccount({ name: 'Checking', type: 'checking' } as any, 0);
      const g = await api.createCategoryGroup({ name: 'G' } as any);
      await api.createCategory({ name: 'Groceries', group_id: g } as any);
    });

    // schema requires splits.min(2); the protocol layer surfaces this as a tool error.
    const res = await call('create_split_transaction', {
      account: 'Checking',
      amount: -90,
      splits: [{ category: 'Groceries', amount: -90 }],
    });
    expect(res.isError).toBe(true);
    expect(res.content[0].text.toLowerCase()).toMatch(/split|array|at least|2/);
  }, 60_000);

  it('reconcile_currency_residual works through the protocol', async () => {
    let acctId = '';
    await createFreshBudget(async () => {
      acctId = await api.createAccount({ name: 'Card (USD)', type: 'credit' } as any, 0);
      const g = await api.createCategoryGroup({ name: 'G' } as any);
      await api.createCategory({ name: 'Cashback', group_id: g } as any);
      await api.addTransactions(
        acctId,
        [{ date: '2026-05-01', amount: -10000, payee_name: 'FX drift' }] as any,
        { learnCategories: false, runTransfers: false },
      );
    });

    const res = await call('reconcile_currency_residual', {
      account: 'Card (USD)',
      target_balance: 0,
      category: 'Cashback',
      date: '2026-06-05',
    });

    expect(res.isError).toBeFalsy();
    expect(res.content[0].text).toContain('Currency residual reconciled');
    expect(await api.getAccountBalance(acctId)).toBe(0);
  }, 60_000);
});
