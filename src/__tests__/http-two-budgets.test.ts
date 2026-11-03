import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

vi.mock('@actual-app/api', () => ({
  default: {},
  utils: {
    amountToInteger: (a: number) => Math.round(a * 100),
    integerToAmount: (c: number) => c / 100,
  },
}));
vi.mock('../connection.js', () => ({
  ensureConnection: vi.fn().mockResolvedValue(undefined),
  getInternal: vi.fn(),
}));

import { startHttpServer } from '../http.js';
import { WorkerPool } from '../workers/pool.js';
import { usePool } from '../workers/current.js';

const STUB = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'workers',
  '__tests__',
  'fixtures',
  'stub-worker.mjs',
);

const READ_TOKEN = `read-${'7a3f91c2b5e08d46'.repeat(2)}`;
const WRITE_TOKEN = `write-${'2e8b47d1c6a09f35'.repeat(2)}`;
const HEADERS = {
  'content-type': 'application/json',
  accept: 'application/json, text/event-stream',
};

/**
 * Two budgets, two paths, one server (#229 over #228).
 *
 * The budgets here are synthetic: the workers are a stub that answers MCP
 * and holds no budget at all, because what is being checked is the way in
 * and the way across, not the engine. What the test asks is the question a
 * deployment asks: can the read credential write, in either budget.
 */
describe('serving two budgets over HTTP', () => {
  let server: Server;
  let base = '';
  let pool: WorkerPool;

  beforeAll(async () => {
    process.env.ACTUAL_BUDGET_ID = 'sync-one';
    process.env.ACTUAL_BUDGET_IDS = 'sync-one,sync-two';
    pool = new WorkerPool({
      command: process.execPath,
      args: [STUB],
      dataDirFor: (budgetId) => path.join('/tmp/actual-mcp-http-test', budgetId),
      log: () => undefined,
    });
    usePool(pool);

    server = await startHttpServer({
      port: 0,
      host: '127.0.0.1',
      readToken: READ_TOKEN,
      writeToken: WRITE_TOKEN,
    });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    delete process.env.ACTUAL_BUDGET_ID;
    delete process.env.ACTUAL_BUDGET_IDS;
    usePool(undefined);
    await pool.stop();
    await new Promise((resolve) => server.close(() => resolve(undefined)));
  });

  async function call(
    path: string,
    token: string,
    body: Record<string, unknown>,
  ): Promise<{ status: number; text: string }> {
    const response = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: { ...HEADERS, authorization: `Bearer ${token}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, ...body }),
    });
    return { status: response.status, text: await response.text() };
  }

  const read = (budgetId?: string) => ({
    method: 'tools/call',
    params: { name: 'get_budget_month', arguments: budgetId ? { budget_id: budgetId } : {} },
  });
  /** A write with the arguments its schema asks for, since the front end checks them. */
  const write = (budgetId?: string) => ({
    method: 'tools/call',
    params: {
      name: 'create_transaction',
      arguments: {
        account: 'Checking',
        amount: -12.5,
        date: '2026-01-05',
        ...(budgetId ? { budget_id: budgetId } : {}),
      },
    },
  });

  it('reads each budget through the budget the call names', async () => {
    const one = await call('/mcp', READ_TOKEN, read('sync-one'));
    const two = await call('/mcp', READ_TOKEN, read('sync-two'));

    expect(one.text).toContain('month of sync-one');
    expect(two.text).toContain('month of sync-two');
    expect(pool.openBudgets().sort()).toEqual(['sync-one', 'sync-two']);
  }, 30_000);

  it('reads the configured budget when a call names none', async () => {
    const reply = await call('/mcp', READ_TOKEN, read());

    expect(reply.text).toContain('month of sync-one');
  }, 30_000);

  it('does not let the read credential write, in either budget', async () => {
    for (const budget of ['sync-one', 'sync-two']) {
      // On the read path the write tool is not registered at all, so the
      // call dies in the front end and no worker hears about it.
      const onRead = await call('/mcp', READ_TOKEN, write(budget));
      expect(onRead.text, budget).not.toContain('written in');
      expect(onRead.text, budget).toMatch(/not found|unknown tool|Tool/i);

      // And the read credential is not the write path's credential.
      const onWrite = await call('/mcp-write', READ_TOKEN, write(budget));
      expect(onWrite.status, budget).toBe(401);
      expect(onWrite.text, budget).not.toContain('written in');
    }
  }, 30_000);

  it('writes through the write path, in the budget the call names', async () => {
    const reply = await call('/mcp-write', WRITE_TOKEN, write('sync-two'));

    expect(reply.text).toContain('written in sync-two');
  }, 30_000);

  it('checks the arguments here, before any worker is asked', async () => {
    const reply = await call('/mcp-write', WRITE_TOKEN, {
      method: 'tools/call',
      params: { name: 'create_transaction', arguments: { budget_id: 'sync-two' } },
    });

    expect(reply.text).toContain('Input validation error');
    // Nothing was sent across: the stub answers with its own words and
    // they are not here.
    expect(reply.text).not.toContain('written in');
  }, 30_000);

  it('answers which budgets it serves without asking a worker', async () => {
    // A worker holds one budget and does not know the others exist: routed
    // like every other tool, this came back `Tool list_budgets not found`
    // against two real budgets, while `tools/list` had just offered it.
    const reply = await call('/mcp', READ_TOKEN, {
      method: 'tools/call',
      params: { name: 'list_budgets', arguments: {} },
    });

    expect(reply.text).toContain('sync-one');
    expect(reply.text).toContain('sync-two');
    expect(reply.text).not.toContain('not found');
  }, 30_000);

  it('does not ask list_budgets which budget it is for', async () => {
    const reply = await call('/mcp', READ_TOKEN, { method: 'tools/list' });
    const listed = JSON.parse(reply.text.replace(/^data: /m, '').trim()) as {
      result: { tools: Array<{ name: string; inputSchema: { properties?: Record<string, unknown> } }> };
    };

    const listBudgets = listed.result.tools.find((tool) => tool.name === 'list_budgets');
    expect(listBudgets).toBeDefined();
    expect(listBudgets?.inputSchema.properties ?? {}).not.toHaveProperty('budget_id');
    // Every other tool does take one.
    const read = listed.result.tools.find((tool) => tool.name === 'get_budget_month');
    expect(read?.inputSchema.properties ?? {}).toHaveProperty('budget_id');
  }, 30_000);

  it('refuses a budget nobody configured, on either path', async () => {
    const onRead = await call('/mcp', READ_TOKEN, read('sync-nine'));
    const onWrite = await call('/mcp-write', WRITE_TOKEN, write('sync-nine'));

    expect(onRead.text).toContain('sync-nine');
    expect(onRead.text).toContain('is configured on this server');
    expect(onWrite.text).toContain('sync-nine');
    expect(pool.openBudgets()).not.toContain('sync-nine');
  }, 30_000);
});
