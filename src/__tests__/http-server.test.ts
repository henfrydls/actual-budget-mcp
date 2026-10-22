import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

// Registering the tools pulls in the engine bundle, and none of this calls
// one: what is being checked is which tools a path offers and who is let in
// at all.
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

import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { startHttpServer } from '../http.js';
import { MIN_TOKEN_LENGTH } from '../utils/http-auth.js';

const READ_TOKEN = 'r'.repeat(MIN_TOKEN_LENGTH);
const WRITE_TOKEN = 'w'.repeat(MIN_TOKEN_LENGTH);

const JSON_HEADERS = {
  'content-type': 'application/json',
  accept: 'application/json, text/event-stream',
};

const INITIALIZE = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'test', version: '0' },
  },
};

/**
 * The HTTP face of the server, over a real socket (#228).
 *
 * Who is let in, which tools each path offers, and the teardown two other
 * servers answered with a 404. Nothing here reaches a budget: the engine is
 * mocked, because what is being checked is the door.
 */
describe('the HTTP server (#228)', () => {
  let server: Server;
  let base = '';

  beforeAll(async () => {
    server = await startHttpServer({
      port: 0,
      host: '127.0.0.1',
      readToken: READ_TOKEN,
      writeToken: WRITE_TOKEN,
    });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise((resolve) => server.close(() => resolve(undefined)));
  });

  async function call(
    path: string,
    body: unknown,
    options: { token?: string; headers?: Record<string, string>; method?: string } = {},
  ): Promise<{ status: number; text: string }> {
    const method = options.method ?? 'POST';
    const response = await fetch(`${base}${path}`, {
      method,
      headers: {
        ...JSON_HEADERS,
        ...(options.token === undefined ? {} : { authorization: `Bearer ${options.token}` }),
        ...options.headers,
      },
      body: method === 'GET' || method === 'DELETE' ? undefined : JSON.stringify(body),
    });
    return { status: response.status, text: await response.text() };
  }

  it('answers initialize on the read path', async () => {
    const { status, text } = await call('/mcp', INITIALIZE, { token: READ_TOKEN });

    expect(status).toBe(200);
    expect(text).toContain('actual-budget-mcp');
  });

  it('offers the read tools and no write tool on the read path', async () => {
    const { status, text } = await call(
      '/mcp',
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
      { token: READ_TOKEN },
    );

    expect(status).toBe(200);
    expect(text).toContain('get_transactions');
    expect(text).not.toContain('create_transaction');
    expect(text).not.toContain('delete_account');
  });

  it('offers the write tools on the write path', async () => {
    const { status, text } = await call(
      '/mcp-write',
      { jsonrpc: '2.0', id: 3, method: 'tools/list' },
      { token: WRITE_TOKEN },
    );

    expect(status).toBe(200);
    expect(text).toContain('create_transaction');
  });

  it('refuses the read token on the write path', async () => {
    const { status } = await call(
      '/mcp-write',
      { jsonrpc: '2.0', id: 4, method: 'tools/list' },
      { token: READ_TOKEN },
    );

    expect(status).toBe(401);
  });

  it('refuses a request with no token, and says what it wanted', async () => {
    const response = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify(INITIALIZE),
    });

    expect(response.status).toBe(401);
    expect(response.headers.get('www-authenticate')).toBe('Bearer');
    expect(await response.text()).toContain('"jsonrpc":"2.0"');
  });

  it('refuses a wrong token of exactly the right length', async () => {
    const { status } = await call('/mcp', INITIALIZE, { token: 'x'.repeat(MIN_TOKEN_LENGTH) });

    expect(status).toBe(401);
  });

  it('refuses anything a browser sends', async () => {
    const { status, text } = await call('/mcp', INITIALIZE, {
      token: READ_TOKEN,
      headers: { origin: 'https://example.com' },
    });

    expect(status).toBe(403);
    expect(text).toContain('does not serve browsers');
  });

  it('answers a teardown instead of 404ing it', async () => {
    // The bug two other servers shipped: `app.post` alone, so a client's
    // DELETE reached the router and got a 404, and the conversation errored.
    // With no session to end, the transport answers it.
    const { status } = await call('/mcp', undefined, { token: READ_TOKEN, method: 'DELETE' });

    expect(status).toBe(200);
  });

  it('lets go of the server and the transport when the response closes', async () => {
    // Nothing in the reply says whether they were released, and a request
    // that ends any other way than by being answered has to release them
    // too. Per-session state that only an explicit close cleared is one of
    // the bugs this design is written against.
    const closed = vi.spyOn(StreamableHTTPServerTransport.prototype, 'close');
    try {
      await call('/mcp', INITIALIZE, { token: READ_TOKEN });
      await vi.waitFor(() => expect(closed).toHaveBeenCalled());
    } finally {
      closed.mockRestore();
    }
  });

  it('checks the token before the method', async () => {
    const { status } = await call('/mcp', undefined, { method: 'DELETE' });

    expect(status).toBe(401);
  });
});

/**
 * A server with nothing to write with.
 *
 * The default: without `ACTUAL_HTTP_WRITE_TOKEN` there is no write path at
 * all, so the strongest thing a caller can do with the credential they have
 * is read.
 */
describe('an HTTP server with no write token', () => {
  let server: Server;
  let base = '';

  beforeAll(async () => {
    server = await startHttpServer({ port: 0, host: '127.0.0.1', readToken: READ_TOKEN });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise((resolve) => server.close(() => resolve(undefined)));
  });

  it('does not serve the write path at all', async () => {
    const response = await fetch(`${base}/mcp-write`, {
      method: 'POST',
      headers: { ...JSON_HEADERS, authorization: `Bearer ${READ_TOKEN}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });

    expect(response.status).toBe(404);
  });

  it('still reads', async () => {
    const response = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { ...JSON_HEADERS, authorization: `Bearer ${READ_TOKEN}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });

    expect(response.status).toBe(200);
    expect(await response.text()).toContain('get_transactions');
  });
});

/**
 * The second line of defence.
 *
 * `readHttpConfig` already refuses to start with a write token and
 * `ACTUAL_READ_ONLY` together, so this path is reached only by a caller that
 * built the app itself. It is here because the cost of the check is one
 * condition and the cost of missing it is a write path on a server someone
 * asked to be read-only.
 */
describe('an HTTP server on a read-only process', () => {
  let server: Server;
  let base = '';

  beforeAll(async () => {
    process.env.ACTUAL_READ_ONLY = '1';
    server = await startHttpServer({
      port: 0,
      host: '127.0.0.1',
      readToken: READ_TOKEN,
      writeToken: WRITE_TOKEN,
    });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    delete process.env.ACTUAL_READ_ONLY;
    await new Promise((resolve) => server.close(() => resolve(undefined)));
  });

  it('mounts no write path, whatever the write token says', async () => {
    const response = await fetch(`${base}/mcp-write`, {
      method: 'POST',
      headers: { ...JSON_HEADERS, authorization: `Bearer ${WRITE_TOKEN}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });

    expect(response.status).toBe(404);
  });
});
