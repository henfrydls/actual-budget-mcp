import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import { connect, type AddressInfo } from 'node:net';

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

const READ_TOKEN = `read-${'7a3f91c2b5e08d46'.repeat(2)}`;
const WRITE_TOKEN = `write-${'2e8b47d1c6a09f35'.repeat(2)}`;

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
    // Whatever the read set holds at the time: `get_schedules` arrived with
    // #150 and belongs on this path by being a read, without anything here
    // being told about it.
    expect(text).toContain('get_schedules');
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

  it('offers no repair tool on the read path, and does on the write path', async () => {
    // `repair_sync` is kept in read-only mode on purpose, because a budget
    // that cannot sync needs a way out (#41). On a read path there is one:
    // the write path. It changes state, and this path says it does not.
    const read = await call('/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/list' }, { token: READ_TOKEN });
    const write = await call('/mcp-write', { jsonrpc: '2.0', id: 1, method: 'tools/list' }, { token: WRITE_TOKEN });

    expect(read.text).not.toContain('repair_sync');
    expect(write.text).toContain('repair_sync');
  });

  it('answers every method it does not take the same way', async () => {
    // The transport answered a PUT itself, offering GET in `Allow`, which
    // is a method this server does not serve either.
    for (const method of ['GET', 'PUT', 'PATCH', 'HEAD']) {
      const response = await fetch(`${base}/mcp`, {
        method,
        headers: { ...JSON_HEADERS, authorization: `Bearer ${READ_TOKEN}` },
      });

      expect(response.status, method).toBe(405);
      expect(response.headers.get('allow'), method).toBe('POST, DELETE');
    }
  });

  it('opens no event stream, and says so', async () => {
    // Left to the transport a GET opens an SSE stream that nothing closes:
    // measured, two hundred of them took the heap from 50 to 100 MB. This
    // server is stateless and sends nothing a client did not ask for.
    const response = await fetch(`${base}/mcp`, {
      method: 'GET',
      headers: { ...JSON_HEADERS, authorization: `Bearer ${READ_TOKEN}` },
    });

    expect(response.status).toBe(405);
    expect(response.headers.get('allow')).toBe('POST, DELETE');
  });

  it('answers a body that is not JSON in the protocol, not in HTML', async () => {
    // Express's own handler answers HTML with a stack trace and absolute
    // paths outside production, and writes the body to stderr in every mode.
    const response = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { ...JSON_HEADERS, authorization: `Bearer ${READ_TOKEN}` },
      body: '{bad',
    });
    const text = await response.text();

    expect(response.status).toBe(400);
    expect(text).toContain('"jsonrpc":"2.0"');
    expect(text).toContain('-32700');
    expect(text).not.toContain('<!DOCTYPE');
    // No stack, and no path out of this machine.
    expect(text).not.toMatch(/\n\s+at /);
    expect(text).not.toContain('.ts:');
    expect(text).not.toContain('/src/');
  });

  it('answers anything else the parser refuses in the protocol too', async () => {
    // A charset it does not know, an encoding it does not know: each one
    // had its own HTML page with a stack trace, and the body went to stderr
    // on the way.
    const cases: Array<Record<string, string>> = [
      { 'content-type': 'application/json; charset=ebcdic' },
      { 'content-encoding': 'xyz' },
    ];

    for (const headers of cases) {
      const response = await fetch(`${base}/mcp`, {
        method: 'POST',
        headers: { ...JSON_HEADERS, authorization: `Bearer ${READ_TOKEN}`, ...headers },
        body: JSON.stringify(INITIALIZE),
      });
      const text = await response.text();

      expect(response.status, JSON.stringify(headers)).toBeGreaterThanOrEqual(400);
      expect(text, JSON.stringify(headers)).toContain('"jsonrpc":"2.0"');
      expect(text, JSON.stringify(headers)).not.toContain('<!DOCTYPE');
      expect(text, JSON.stringify(headers)).not.toContain('.ts:');
    }
  });

  it('refuses a body too large, in the protocol', async () => {
    const response = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { ...JSON_HEADERS, authorization: `Bearer ${READ_TOKEN}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: { pad: 'x'.repeat(3_000_000) } }),
    });
    const text = await response.text();

    expect(response.status).toBe(413);
    expect(text).toContain('"jsonrpc":"2.0"');
    expect(text).not.toContain('<!DOCTYPE');
  });

  it('reads no body at all before the token is checked', async () => {
    // The order is the point: with the body parsed first, a caller with no
    // credential could put 100 KB of anything into the log and read a stack
    // trace back.
    const response = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: JSON_HEADERS,
      body: '{bad',
    });

    expect(response.status).toBe(401);
    expect(await response.text()).not.toContain('-32700');
  });

  it('takes a header written with more than one space, and not with a tab', async () => {
    const spaces = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { ...JSON_HEADERS, authorization: `Bearer   ${READ_TOKEN}` },
      body: JSON.stringify(INITIALIZE),
    });
    const tab = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { ...JSON_HEADERS, authorization: `Bearer\t${READ_TOKEN}` },
      body: JSON.stringify(INITIALIZE),
    });

    expect(spaces.status).toBe(200);
    expect(tab.status).toBe(401);
  });

  it('refuses two credentials in one request', async () => {
    // Node keeps the first and hides the rest, so a proxy that adds one
    // silently decides which is used. `fetch` cannot send two: the Headers
    // class joins them into one value, which this also refuses. So the
    // request goes over a socket, written the way a proxy would write it.
    const body = JSON.stringify(INITIALIZE);
    const raw = [
      'POST /mcp HTTP/1.1',
      `Host: 127.0.0.1:${(server.address() as AddressInfo).port}`,
      'Content-Type: application/json',
      'Accept: application/json, text/event-stream',
      `Authorization: Bearer ${READ_TOKEN}`,
      `Authorization: Bearer ${WRITE_TOKEN}`,
      `Content-Length: ${Buffer.byteLength(body)}`,
      'Connection: close',
      '',
      body,
    ].join('\r\n');

    const answer = await new Promise<string>((resolve, reject) => {
      const socket = connect((server.address() as AddressInfo).port, '127.0.0.1', () => {
        socket.write(raw);
      });
      let text = '';
      socket.on('data', (chunk) => {
        text += String(chunk);
      });
      socket.on('end', () => resolve(text));
      socket.on('error', reject);
    });

    expect(answer.split('\r\n')[0]).toContain('400');
    expect(answer).toContain('More than one Authorization header');
  });

  it('refuses the Origin a page sends when it has none', async () => {
    const { status } = await call('/mcp', INITIALIZE, {
      token: READ_TOKEN,
      headers: { origin: 'null' },
    });

    expect(status).toBe(403);
  });

  it('binds the address it was given and no other', async () => {
    // `0.0.0.0` answers on 127.0.0.1 too, so a server that quietly bound
    // every interface would pass every other test in this file while being
    // reachable from the network.
    expect((server.address() as AddressInfo).address).toBe('127.0.0.1');
  });

  it('takes a body far larger than Express would, because a batch is', async () => {
    // Three thousand transactions at about 150 bytes a row is some 450 KB.
    // Express's own default is 100 KB, which refused a batch of eight
    // hundred.
    const padding = 'x'.repeat(500_000);
    const response = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { ...JSON_HEADERS, authorization: `Bearer ${READ_TOKEN}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: { padding } }),
    });

    expect(response.status).not.toBe(413);
    expect(response.status).toBe(200);
  });

  it('says nothing about what it is built with', async () => {
    const response = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { ...JSON_HEADERS, authorization: `Bearer ${READ_TOKEN}` },
      body: JSON.stringify(INITIALIZE),
    });

    expect(response.headers.get('x-powered-by')).toBeNull();
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

    // The same answer a wrong credential gets, in JSON, so that nobody
    // outside learns which paths exist here.
    expect(response.status).toBe(401);
    expect(await response.text()).toContain('"jsonrpc":"2.0"');
  });

  it('says nothing about which paths exist to a caller with no token', async () => {
    for (const path of ['/mcp-write', '/anything']) {
      const response = await fetch(`${base}${path}`, {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      });

      expect(response.status, path).toBe(401);
    }
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

    // Not a credential this server holds at all, so it is not told what is
    // or is not served here.
    expect(response.status).toBe(401);
  });

  it('still reads, with the read token', async () => {
    const response = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { ...JSON_HEADERS, authorization: `Bearer ${READ_TOKEN}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });

    expect(response.status).toBe(200);
  });
});

/**
 * A port that is already taken.
 *
 * Express 5 hands a failed bind to the listening callback, so a server that
 * only listened for the `error` event resolved anyway: the process said it
 * was serving, held the data directory and the session, and listened to
 * nothing. Nobody reads a log line that says the opposite of what the
 * process is doing.
 */
describe('starting on a port that is in use', () => {
  it('fails rather than saying it started', async () => {
    const taken = createServer();
    await new Promise<void>((resolve) => taken.listen(0, '127.0.0.1', resolve));
    const { port } = taken.address() as AddressInfo;

    try {
      await expect(
        startHttpServer({ port, host: '127.0.0.1', readToken: READ_TOKEN }),
      ).rejects.toThrow(/EADDRINUSE/);
    } finally {
      await new Promise((resolve) => taken.close(() => resolve(undefined)));
    }
  });
});

/**
 * Off loopback, where the automatic protection does not apply.
 *
 * The SDK turns on host validation by itself for a loopback host and not for
 * any other, so a server bound wide answered a request for any name that
 * resolved to it. The configuration refuses to start without the list; this
 * is the list doing its job.
 */
describe('an HTTP server with a host list', () => {
  let server: Server;
  let port = 0;

  beforeAll(async () => {
    server = await startHttpServer({
      port: 0,
      host: '127.0.0.1',
      allowedHosts: ['budget.example.com'],
      readToken: READ_TOKEN,
    });
    port = (server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    await new Promise((resolve) => server.close(() => resolve(undefined)));
  });

  /**
   * Over a socket, because `fetch` will not send a `Host` of someone
   * else's choosing: the Headers class refuses it, which is exactly the
   * request this has to make.
   */
  async function withHost(host: string): Promise<string> {
    const body = JSON.stringify(INITIALIZE);
    const raw = [
      'POST /mcp HTTP/1.1',
      `Host: ${host}`,
      'Content-Type: application/json',
      'Accept: application/json, text/event-stream',
      `Authorization: Bearer ${READ_TOKEN}`,
      `Content-Length: ${Buffer.byteLength(body)}`,
      'Connection: close',
      '',
      body,
    ].join('\r\n');

    return new Promise<string>((resolve, reject) => {
      const socket = connect(port, '127.0.0.1', () => socket.write(raw));
      let text = '';
      socket.on('data', (chunk) => {
        text += String(chunk);
      });
      socket.on('end', () => resolve(text.split('\r\n')[0]));
      socket.on('error', reject);
    });
  }

  it('answers to a name on the list', async () => {
    expect(await withHost('budget.example.com')).toContain('200');
  });

  it('refuses a name that is not on it, before anything else', async () => {
    expect(await withHost('evil.example')).toContain('403');
  });
});

/**
 * The write path, reached by a name that is not quite it.
 *
 * Express matches a route without regard to case or a trailing slash unless
 * it is told to. With the credential decided by comparing the path to a
 * string, `/MCP-WRITE` was a path this server did not serve, so any token it
 * held was accepted, and then the router handed the request to the write
 * route anyway. Measured: the read token listed every tool through
 * `/MCP-WRITE` and created a transaction with one.
 *
 * So the route decides which credential it wants, because the route is the
 * only thing that knows which one matched, and the router is told to take
 * the path literally.
 */
describe('a path that is nearly the write path', () => {
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

  async function list(path: string, token: string): Promise<{ status: number; text: string }> {
    const response = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: { ...JSON_HEADERS, authorization: `Bearer ${token}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    return { status: response.status, text: await response.text() };
  }

  it('refuses the read token on every spelling of the write path', async () => {
    for (const path of [
      '/MCP-WRITE',
      '/Mcp-Write',
      '/mcp-write/',
      '/mcp-WRITE/',
      '/mcp//write',
      '/mcp-write//',
    ]) {
      const { status, text } = await list(path, READ_TOKEN);

      expect(status, path).toBe(401);
      expect(text, path).not.toContain('create_transaction');
    }
  });

  it('refuses the write token on every spelling of the read path', async () => {
    for (const path of ['/MCP', '/mcp/', '/Mcp']) {
      const { status } = await list(path, WRITE_TOKEN);

      expect(status, path).toBe(401);
    }
  });

  it('refuses the write token too, on anything but the path itself', async () => {
    // The credential is right here, so what refuses the request is the
    // router taking the path literally. Without that it writes.
    for (const path of ['/MCP-WRITE', '/mcp-write/', '/Mcp-Write']) {
      const { status, text } = await list(path, WRITE_TOKEN);

      expect(status, path).toBe(401);
      expect(text, path).not.toContain('create_transaction');
    }
  });

  it('refuses the read token on anything but the read path itself', async () => {
    for (const path of ['/MCP', '/mcp/']) {
      const { status } = await list(path, READ_TOKEN);

      expect(status, path).toBe(401);
    }
  });

  it('still serves the two paths spelled as they are', async () => {
    expect((await list('/mcp', READ_TOKEN)).status).toBe(200);
    expect((await list('/mcp-write', WRITE_TOKEN)).text).toContain('create_transaction');
  });
});
