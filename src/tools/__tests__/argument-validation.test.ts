import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

vi.mock('@actual-app/api', () => ({
  default: {},
  utils: {
    amountToInteger: (a: number, places = 2) => Math.round(a * Math.pow(10, places)),
    integerToAmount: (c: number, places = 2) => c / Math.pow(10, places),
  },
}));
vi.mock('../../connection.js', () => ({
  ensureConnection: vi.fn().mockRejectedValue(new Error('no connection in this test')),
  getInternal: vi.fn(),
}));

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { registerAllTools } from '../index.js';

/**
 * What a client is told when it calls a tool wrong (#280).
 *
 * Through the real protocol, because the validation is the SDK's and the
 * words are the schema library's: neither is ours, and both changed under
 * us when zod went from 3 to 4. What this holds is not the wording, which
 * is theirs to change, but the three things a caller needs from a refusal:
 * that it is refused, which argument is wrong, and what was expected.
 */
describe('calling a tool with the wrong arguments', () => {
  let client: Client;
  let schemas: Map<string, unknown>;

  beforeAll(async () => {
    const server = new McpServer({ name: 'test', version: '0' });
    registerAllTools(server);
    const [a, b] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: 'test', version: '0' }, { capabilities: {} });
    await Promise.all([server.connect(b), client.connect(a)]);
    const { tools } = await client.listTools();
    schemas = new Map(tools.map((t) => [t.name, t.inputSchema]));
  });

  afterAll(async () => {
    await client.close();
  });

  async function refusal(name: string, args: Record<string, unknown>): Promise<string> {
    const reply = (await client.callTool({ name, arguments: args })) as {
      isError?: boolean;
      content?: Array<{ text?: string }>;
    };
    expect(reply.isError, `${name} should have refused ${JSON.stringify(args)}`).toBe(true);
    return (reply.content ?? []).map((c) => c.text ?? '').join(' ');
  }

  it('refuses a missing required argument and names it', async () => {
    const said = await refusal('get_category_balance', {});

    expect(said).toContain('get_category_balance');
    expect(said).toContain('category');
    expect(said.toLowerCase()).toContain('string');
  });

  it('refuses the wrong type and says which type it wanted', async () => {
    expect((await refusal('get_category_balance', { category: 42 })).toLowerCase()).toContain(
      'expected string',
    );
    expect((await refusal('get_categories', { include_hidden: 'yes' })).toLowerCase()).toContain(
      'expected boolean',
    );
  });

  it('refuses a number that breaks a limit, and says which limit', async () => {
    expect(await refusal('get_rules', { limit: 2.5 })).toMatch(/int/i);
    // Greater than zero: a page of no rules is not a page.
    expect(await refusal('get_rules', { limit: 0 })).toMatch(/0/);
    expect(await refusal('get_rules', { offset: -1 })).toMatch(/0/);
  });

  it('refuses a value outside an enum and lists the ones there are', async () => {
    const said = await refusal('reconcile_account', {
      account: 'Checking',
      expected_balance: 1,
      balance_counts: 'sometimes',
    });

    expect(said).toContain('all');
    expect(said).toContain('cleared_only');
  });

  it('names the row and the field when one item of a list is wrong', async () => {
    const said = await refusal('create_transactions', {
      transactions: [{ account: 'Checking', date: '2026-01-01', amount: 'a lot' }],
    });

    // The index matters: a batch of three thousand rows with one bad one is
    // unfixable without it.
    expect(said).toContain('transactions[0].amount');
  });

  it('ignores an argument it does not know rather than refusing the call', async () => {
    // It reaches the tool, which fails for its own reason here. A client
    // that adds a field must not have its call rejected for it.
    const reply = (await client.callTool({
      name: 'get_categories',
      arguments: { include_hidden: true, invented: 'x' },
    })) as { content?: Array<{ text?: string }> };
    const said = (reply.content ?? []).map((c) => c.text ?? '').join(' ');

    expect(said).not.toContain('Input validation error');
  });

  it('tells a client that no tool takes an argument it did not ask for', () => {
    // Every object in every schema, the nested ones included: the rows of a
    // batch are where a model is most tempted to invent a field. The line
    // was there until zod 4 stopped emitting it by default, and losing it
    // is losing the hint, not a rule the server ever enforced (#280).
    const missing: string[] = [];
    const walk = (node: unknown, where: string) => {
      if (Array.isArray(node)) {
        node.forEach((item, i) => walk(item, `${where}[${i}]`));
        return;
      }
      if (typeof node !== 'object' || node === null) return;
      const record = node as Record<string, unknown>;
      if (record.type === 'object' && record.additionalProperties !== false) missing.push(where);
      for (const [key, value] of Object.entries(record)) walk(value, `${where}.${key}`);
    };

    for (const [name, schema] of schemas) {
      const properties = (schema as { properties?: Record<string, unknown> }).properties ?? {};
      // A tool that takes no arguments never carried the line and does not
      // need it: there is nothing to invent.
      if (Object.keys(properties).length === 0) continue;
      walk(schema, name);
    }

    expect(missing).toEqual([]);
  });

  it('offers no schema a client has to resolve a reference to', () => {
    // Some clients do not resolve `$ref`, and one that does not would read
    // an empty constraint and send anything. Nothing needs them: the
    // schemas here are small enough to repeat.
    for (const [name, schema] of schemas) {
      expect(JSON.stringify(schema), name).not.toContain('$ref');
    }
  });
});
