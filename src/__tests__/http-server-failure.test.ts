import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

vi.mock('@actual-app/api', () => ({
  default: {},
  utils: {
    amountToInteger: (a: number) => Math.round(a * 100),
    integerToAmount: (c: number) => c / 100,
  },
}));

// The one thing a request cannot carry on by itself: building the server it
// is going to be answered by.
vi.mock('../mcp-server.js', () => ({
  createMcpServer: () => {
    throw new Error('the budget could not be opened at https://user:secret@budget.example.com');
  },
}));

import { startHttpServer } from '../http.js';

const TOKEN = `read-${'7a3f91c2b5e08d46'.repeat(2)}`;

/**
 * What a client is told when the request could not be served at all.
 *
 * The reply is the protocol's, not a stack, and it says nothing about what
 * went wrong inside: the message here carries a server address with a
 * password in it, which is what an engine error looks like.
 */
describe('a request that cannot be served', () => {
  let server: Server;
  let base = '';

  beforeAll(async () => {
    server = await startHttpServer({ port: 0, host: '127.0.0.1', readToken: TOKEN });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise((resolve) => server.close(() => resolve(undefined)));
  });

  it('answers 500 in the protocol, and keeps the reason to itself', async () => {
    const response = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: `Bearer ${TOKEN}`,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    const text = await response.text();

    expect(response.status).toBe(500);
    expect(text).toContain('"jsonrpc":"2.0"');
    expect(text).not.toContain('secret');
    expect(text).not.toContain('budget.example.com');
    expect(text).not.toMatch(/\n\s+at /);
  });
});
