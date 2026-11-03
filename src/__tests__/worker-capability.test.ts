import { describe, it, expect, afterEach, vi } from 'vitest';
import crypto from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

vi.mock('@actual-app/api', () => ({
  default: {},
  utils: {
    amountToInteger: (a: number) => Math.round(a * 100),
    integerToAmount: (c: number) => c / 100,
  },
}));

import { createMcpServer } from '../mcp-server.js';

const VARS = ['ACTUAL_MCP_WORKER', 'ACTUAL_BUDGET_ID', 'ACTUAL_BUDGET_IDS', 'ACTUAL_TOOLSET'];

/** What the pool puts on a worker's command line, and nobody else does. */
const WORKER_FLAG = '--worker';

/**
 * What a client is told at `initialize` (#229).
 *
 * A worker reports its budget's name upwards, and the notification that
 * carries it needs the `logging` capability declared. Declaring it changes
 * what every client is told, so it is declared only in a process the pool
 * started, and that is what this holds: with one budget, what goes out is
 * what went out before any of this.
 */
describe('what a server says it can do', () => {
  afterEach(() => {
    for (const name of VARS) delete process.env[name];
    const at = process.argv.indexOf(WORKER_FLAG);
    if (at !== -1) process.argv.splice(at, 1);
  });

  async function connected(): Promise<{ capabilities: unknown; tools: string }> {
    const server = createMcpServer();
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test', version: '0' });
    await Promise.all([server.connect(b), client.connect(a)]);
    const { tools } = await client.listTools();
    const capabilities = client.getServerCapabilities();
    await client.close();
    return {
      capabilities,
      tools: crypto.createHash('sha256').update(JSON.stringify(tools)).digest('hex'),
    };
  }

  it('declares logging only in a process the pool started, and nothing else moves', async () => {
    process.env.ACTUAL_BUDGET_ID = 'sync-one';
    const plain = await connected();

    process.argv.push(WORKER_FLAG);
    const worker = await connected();

    expect(plain.capabilities).not.toHaveProperty('logging');
    expect(worker.capabilities).toHaveProperty('logging');
    // Everything else is the same, capability by capability: the marker is
    // about what a worker can say, not about what it can do.
    const { logging, ...rest } = worker.capabilities as Record<string, unknown>;
    expect(logging).toEqual({});
    expect(rest).toEqual(plain.capabilities);
    expect(worker.tools).toBe(plain.tools);
  });

  it('is the same server in every other way it is configured', async () => {
    // Being a worker is not configuration, so it changes nothing that
    // configuration changes.
    process.env.ACTUAL_BUDGET_ID = 'sync-one';
    process.env.ACTUAL_TOOLSET = 'chat';
    const plain = await connected();

    process.argv.push(WORKER_FLAG);
    expect((await connected()).tools).toBe(plain.tools);
  });

  it('cannot be turned into a worker by anything in the environment', async () => {
    // An environment is inherited and a command line is not. A user who
    // exports this, for whatever reason, would otherwise have a server
    // that declares a capability nobody asked for and reports its budget's
    // name to its own client.
    process.env.ACTUAL_BUDGET_ID = 'sync-one';
    const plain = await connected();

    for (const name of ['ACTUAL_MCP_WORKER', 'ACTUAL_WORKER', 'MCP_WORKER']) {
      process.env[name] = '1';
    }
    const after = await connected();

    expect(after.capabilities).toEqual(plain.capabilities);
    expect(after.capabilities).not.toHaveProperty('logging');
    expect(after.tools).toBe(plain.tools);
    for (const name of ['ACTUAL_WORKER', 'MCP_WORKER']) delete process.env[name];
  });
});
