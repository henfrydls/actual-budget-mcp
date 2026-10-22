import type { Request, Response } from 'express';
import type { Server } from 'node:http';
import { createMcpExpressApp } from '@modelcontextprotocol/sdk/server/express.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createMcpServer } from './mcp-server.js';
import { bearerFrom, tokenMatches } from './utils/http-auth.js';
import { READ_PATH, WRITE_PATH, type HttpConfig } from './utils/http-config.js';
import { isReadOnly } from './utils/mode.js';

/**
 * The HTTP face of this server (#228).
 *
 * Stateless: a fresh server and a fresh transport per request, with
 * `sessionIdGenerator: undefined`, both closed when the response closes.
 *
 * Sessions were the alternative and they are what other servers got wrong.
 * Three of the four bugs read before this was written are a session
 * lifecycle: a `DELETE` that was never routed, so a client's teardown got a
 * 404 and the conversation errored, and per-session budget state that only
 * an explicit close cleared, so every other way a session ended leaked it
 * for the life of the process. With no sessions there is nothing to leak and
 * nothing to terminate, and the SDK answers `DELETE` itself: with no session
 * id to check, a teardown gets a 200. That only holds if the route takes all
 * three methods and lets the transport answer, which is why these are
 * `app.all` and not `app.post`.
 *
 * What statelessness costs is server-initiated notifications and
 * resumability. This server sends neither.
 *
 * Nothing here logs a tool result, at any level. The fourth bug was a
 * default deployment writing whole transaction rows, payees and notes to
 * stdout: that server redacted secrets, and budget content is not a secret
 * by that definition. The rule that holds is narrower and easier to keep.
 */

/** A JSON-RPC shaped refusal, so a client reads it as a protocol error. */
function refuse(res: Response, status: number, message: string): void {
  res.status(status).json({
    jsonrpc: '2.0',
    error: { code: -32001, message },
    id: null,
  });
}

/**
 * Serve one request, with its own server and transport.
 *
 * `writes` decides which tools the server registers, not whether a tool is
 * refused when called: a tool that is never registered cannot be called,
 * talked into being called, or spent context on, which is the same choice
 * `ACTUAL_READ_ONLY` makes.
 */
async function serve(req: Request, res: Response, token: string, writes: boolean): Promise<void> {
  // No browser is a legitimate client of this server, and a page trying to
  // reach it is what sends an `Origin`. The SDK's host-header validation
  // already covers DNS rebinding; this covers the page that knows the
  // address.
  if (req.headers.origin !== undefined) {
    refuse(res, 403, 'This server does not serve browsers: a request with an Origin header is refused.');
    return;
  }

  if (!tokenMatches(bearerFrom(req.headers.authorization), token)) {
    res.setHeader('WWW-Authenticate', 'Bearer');
    refuse(res, 401, 'Missing or wrong bearer token.');
    return;
  }

  const server = createMcpServer({ readOnly: !writes });
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });

  // Both of them, on the way out. The transport holds the response and the
  // server holds the transport, and a request that ends any other way than
  // by being answered still has to let go of them.
  res.on('close', () => {
    void transport.close();
    void server.close();
  });

  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
}

/**
 * The app, with the paths this configuration actually serves.
 *
 * Two paths rather than one tool-by-tool decision: a gateway in front can
 * hand the write registration to one client and not to others, which is what
 * the deployment this was modelled on settled on by itself. Without a write
 * token there is no write path at all, so the default is a server that
 * cannot change anything.
 */
export function createHttpApp(config: HttpConfig) {
  const app = createMcpExpressApp({ host: config.host, allowedHosts: config.allowedHosts });

  app.all(READ_PATH, (req, res) => {
    void serve(req, res, config.readToken, false).catch(() => {
      if (!res.headersSent) refuse(res, 500, 'The server could not handle that request.');
    });
  });

  if (config.writeToken !== undefined && !isReadOnly()) {
    app.all(WRITE_PATH, (req, res) => {
      void serve(req, res, config.writeToken as string, true).catch(() => {
        if (!res.headersSent) refuse(res, 500, 'The server could not handle that request.');
      });
    });
  }

  return app;
}

/** Listen, and resolve once the port is actually bound. */
export function startHttpServer(config: HttpConfig): Promise<Server> {
  const app = createHttpApp(config);
  return new Promise((resolve, reject) => {
    const server = app.listen(config.port, config.host, () => resolve(server));
    server.on('error', reject);
  });
}
