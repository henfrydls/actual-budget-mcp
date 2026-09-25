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
import { registerCreateTransaction } from '../../write/create-transaction.js';

const skip = process.env.SKIP_ACTUAL_INTEGRATION === '1';

/**
 * The warning is read by a client over the protocol, not by the function.
 * A message composed in one place and returned from another passes a test on
 * the function while the user sees nothing.
 */
describe.skipIf(skip)('create_transaction duplicate warning through the protocol (#88)', () => {
  let client: Client;

  const call = (args: Record<string, unknown>) =>
    client.callTool({ name: 'create_transaction', arguments: args }) as Promise<{
      content: Array<{ type: string; text: string }>;
      isError?: boolean;
    }>;

  beforeAll(async () => {
    await initTestEngine();
    const server = new McpServer({ name: 'test', version: '0.0.0' });
    registerCreateTransaction(server);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: 'test-client', version: '0.0.0' });
    await server.connect(serverTransport);
    await client.connect(clientTransport);
  }, 60_000);

  afterAll(async () => {
    await shutdownTestEngine();
  });

  async function budgetWithOne() {
    let checking = '';
    await createFreshBudget(async () => {
      checking = await api.createAccount({ name: 'Checking', type: 'checking' } as any, 0);
    });
    await api.addTransactions(checking, [
      { date: '2026-06-05', amount: -5000, notes: 'EXISTING-ONE' },
    ] as never);
    return checking;
  }

  it('advertises allow_duplicate, so a client can act on the warning', async () => {
    const { tools } = await client.listTools();
    const tool = tools.find((t) => t.name === 'create_transaction');

    expect(Object.keys((tool!.inputSchema as { properties: object }).properties)).toContain(
      'allow_duplicate',
    );
  });

  it('returns the warning over the wire, naming the existing transaction', async () => {
    await budgetWithOne();

    const res = await call({ account: 'Checking', amount: -50, date: '2026-06-05' });

    expect(res.content[0].text).toMatch(/already exists/i);
    expect(res.content[0].text).toMatch(/EXISTING-ONE/);
    expect(res.content[0].text).toMatch(/allow_duplicate/);
  });

  it('is not an error: the caller is being asked, not refused', async () => {
    // An agent reading `isError` would treat this as a failure and may retry
    // blindly, which is the opposite of what the warning is for.
    await budgetWithOne();

    const res = await call({ account: 'Checking', amount: -50, date: '2026-06-05' });

    expect(res.isError).toBeUndefined();
  });

  it('creates when the flag comes through the protocol', async () => {
    const checking = await budgetWithOne();

    const res = await call({
      account: 'Checking',
      amount: -50,
      date: '2026-06-05',
      allow_duplicate: true,
    });

    expect(res.content[0].text).toMatch(/Transaction created/);
    const rows = await api.getTransactions(checking, '2026-06-05', '2026-06-05');
    expect(rows.length).toBe(2);
  });
});
