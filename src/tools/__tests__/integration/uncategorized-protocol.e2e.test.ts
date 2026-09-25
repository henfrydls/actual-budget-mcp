import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

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
import { registerGetTransactions } from '../../read/get-transactions.js';

const skip = process.env.SKIP_ACTUAL_INTEGRATION === '1';

/**
 * Through the protocol, not through the function.
 *
 * The flag is declared in a zod schema, and an audit found that deleting it
 * from that schema broke no test at all: every test called
 * `getTransactionsReport` directly. Over the wire the effect is worse than a
 * crash — the SDK drops an unknown key silently, so `uncategorized: true` comes
 * back with the categorised rows too and nothing reports a problem.
 *
 * The promise in the issue is "a flag on get_transactions". That promise lives
 * in the schema, so it has to be tested where the schema is used.
 */
describe.skipIf(skip)('get_transactions through the MCP protocol (#81)', () => {
  let client: Client;

  const call = (name: string, args: Record<string, unknown>) =>
    client.callTool({ name, arguments: args }) as Promise<{
      content: Array<{ type: string; text: string }>;
      isError?: boolean;
    }>;

  beforeAll(async () => {
    await initTestEngine();
    const server = new McpServer({ name: 'test', version: '0.0.0' });
    registerGetTransactions(server);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: 'test-client', version: '0.0.0' });
    await server.connect(serverTransport);
    await client.connect(clientTransport);
  }, 60_000);

  afterAll(async () => {
    await shutdownTestEngine();
  });

  async function budget() {
    let acct = '';
    let cat = '';
    await createFreshBudget(async () => {
      acct = await api.createAccount({ name: 'Checking', type: 'checking' } as any, 0);
      const g = await api.createCategoryGroup({ name: 'G' } as any);
      cat = await api.createCategory({ name: 'Groceries', group_id: g } as any);
    });
    await api.addTransactions(acct, [
      { date: '2026-06-05', amount: -100, category: cat, notes: 'ALREADY-SORTED' },
      { date: '2026-06-06', amount: -200, notes: 'AWAITING-A-CATEGORY' },
    ] as any);
  }

  it('advertises the flag, so a client can discover it', async () => {
    const { tools } = await client.listTools();
    const tool = tools.find((t) => t.name === 'get_transactions');

    expect(tool).toBeDefined();
    expect(Object.keys((tool!.inputSchema as { properties: object }).properties)).toContain(
      'uncategorized',
    );
  });

  it('honours the flag over the wire, instead of dropping it silently', async () => {
    await budget();

    const res = await call('get_transactions', { uncategorized: true });

    expect(res.isError).toBeFalsy();
    expect(res.content[0].text).toMatch(/AWAITING-A-CATEGORY/);
    // Without the flag in the schema the key is discarded and this row comes
    // back too, with no error anywhere.
    expect(res.content[0].text).not.toMatch(/ALREADY-SORTED/);
  });

  it('still returns everything when the flag is not set', async () => {
    await budget();

    const res = await call('get_transactions', { start_date: '2026-06-01', end_date: '2026-06-30' });

    expect(res.content[0].text).toMatch(/ALREADY-SORTED/);
    expect(res.content[0].text).toMatch(/AWAITING-A-CATEGORY/);
  });
});
