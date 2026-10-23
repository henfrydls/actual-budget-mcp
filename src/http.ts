import express, { type Request, type Response, type NextFunction } from 'express';
import type { Server } from 'node:http';
import {
  hostHeaderValidation,
  localhostHostValidation,
} from '@modelcontextprotocol/sdk/server/middleware/hostHeaderValidation.js';
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
 * ## The order the middleware runs in is the design
 *
 * Host, then origin, then token, then the body. The first version used the
 * SDK's `createMcpExpressApp`, which mounts its own `express.json()` as part
 * of building the app, so every request was parsed before anyone had been
 * asked for a credential. An audit got two things out of that with no token
 * at all: a 400 carrying a stack trace and absolute paths, and the body
 * itself written to stderr by Express's default error handler. A truncated
 * JSON object holds payees and notes, so that is budget content in the log,
 * and anyone could put 100 KB of it there per request.
 *
 * So the app is built here instead, with the SDK's host validation middleware
 * imported on its own, and nothing reads a body until the token has been
 * checked. Our own handler answers a bad or oversized body in JSON-RPC and
 * writes nothing anywhere.
 *
 * Nothing here logs a tool result either, at any level. The fourth bug was a
 * default deployment writing whole transaction rows, payees and notes to
 * stdout at `info`; that server's redaction was written for secrets, and
 * budget content is not a secret by that definition. The rule that holds is
 * narrower and easier to keep.
 */

/**
 * What a request body may weigh.
 *
 * Sized from the largest thing this server is asked to do: a batch of three
 * thousand transactions. Measured at about 150 bytes a row, that is some
 * 450 KB, so two megabytes leaves room for notes and long payee names
 * without letting an unauthenticated caller push anything near a gigabyte
 * through the parser. Express's own default is 100 KB, which refused a
 * batch of eight hundred rows.
 */
export const BODY_LIMIT = '2mb';

/** A JSON-RPC shaped refusal, so a client reads it as a protocol error. */
function refuse(res: Response, status: number, message: string, code = -32001): void {
  res.status(status).json({ jsonrpc: '2.0', error: { code, message }, id: null });
}

/** How many times a header was actually sent, which `req.headers` hides. */
function headerCount(req: Request, name: string): number {
  let count = 0;
  for (let i = 0; i < req.rawHeaders.length; i += 2) {
    if (req.rawHeaders[i].toLowerCase() === name) count += 1;
  }
  return count;
}

/**
 * What every request has to pass, whatever it is for.
 *
 * No credential is checked here. Which credential a request needs is the
 * route's to say, because the route is the only thing that knows which one
 * actually matched: deciding it here, by comparing the path to a string,
 * is how the read token came to be accepted on the write path. Express
 * matches `/MCP-WRITE` and `/mcp-write/` to `app.all('/mcp-write')` unless
 * it is told not to, and a guard that compared text saw a path it did not
 * serve and waved any credential through.
 */
function entryChecks(req: Request, res: Response, next: NextFunction): void {
  // No browser is a legitimate client of this server, and a page trying to
  // reach it is what sends an `Origin`. The host validation above covers
  // DNS rebinding; this covers the page that knows the address.
  if (req.headers.origin !== undefined) {
    refuse(res, 403, 'This server does not serve browsers: a request with an Origin header is refused.');
    return;
  }

  // Two credentials in one request is a question nobody can answer
  // correctly: Node keeps the first and hides the rest, so a proxy adding
  // one silently decides which is used.
  if (headerCount(req, 'authorization') > 1) {
    refuse(res, 400, 'More than one Authorization header was sent.');
    return;
  }

  next();
}

/** The credential this route wants, and nothing else will do. */
function requires(token: string | undefined) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!tokenMatches(bearerFrom(req.headers.authorization), token)) {
      res.setHeader('WWW-Authenticate', 'Bearer');
      refuse(res, 401, 'Missing or wrong bearer token.');
      return;
    }
    next();
  };
}

/**
 * A body that could not be read, in the protocol's own words.
 *
 * Express's default handler answers HTML with a stack trace outside
 * production and writes the body to stderr in every mode. Both are replaced
 * here, and neither the body nor anything derived from it is logged.
 */
function badBody(error: unknown, _req: Request, res: Response, next: NextFunction): void {
  if (res.headersSent) {
    next(error);
    return;
  }
  const { type, status, statusCode } = error as {
    type?: string;
    status?: number;
    statusCode?: number;
  };
  const code = status ?? statusCode;

  if (type === 'entity.too.large') {
    refuse(res, 413, `That request body is larger than this server accepts (${BODY_LIMIT}).`);
    return;
  }
  if (type === 'entity.parse.failed') {
    refuse(res, 400, 'That request body is not JSON.', -32700);
    return;
  }
  // Everything else the parser refuses: a charset it does not know, an
  // encoding it does not know, compressed bytes that do not decompress. Each
  // one had its own HTML page with a stack trace in it, and Express wrote
  // the body to stderr on the way. Nothing here is logged, and the answer
  // is the protocol's.
  if (type !== undefined || (typeof code === 'number' && code >= 400 && code < 500)) {
    refuse(res, code ?? 400, 'That request body could not be read.');
    return;
  }
  next(error);
}

/** Serve one request, with its own server and transport. */
async function serve(req: Request, res: Response, writes: boolean): Promise<void> {
  // The specification lets a server that offers no stream say so, and this
  // one offers none: it is stateless and sends nothing a client did not ask
  // for. Left to the transport, a GET opens an SSE stream that nothing ever
  // closes, and two hundred of them doubled the heap.
  if (req.method !== 'POST' && req.method !== 'DELETE') {
    // One answer for every method this server does not take, rather than
    // the transport's for some and ours for others: a GET left to it opens
    // an event stream that nothing closes, and two hundred of those doubled
    // the heap, while a PUT came back offering GET.
    res.setHeader('Allow', 'POST, DELETE');
    refuse(res, 405, 'This server opens no event stream: use POST, or DELETE to end a session.');
    return;
  }

  const server = createMcpServer({ readOnly: !writes, includeRepairSync: writes });
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
  const writes = config.writeToken !== undefined && !isReadOnly();
  const app = express();

  // Two paths and two credentials mean nothing if `/MCP-WRITE` and
  // `/mcp-write/` reach the write path as well, which is what Express does
  // by default. Measured: the read token wrote a transaction through
  // `/MCP-WRITE`.
  app.set('case sensitive routing', true);
  app.set('strict routing', true);

  // Says what the server is running to anyone who asks, and answers no
  // question worth asking.
  app.disable('x-powered-by');

  // The DNS rebinding protection the specification asks for, taken from the
  // SDK rather than written again.
  app.use(
    config.allowedHosts === undefined
      ? localhostHostValidation()
      : hostHeaderValidation(config.allowedHosts),
  );
  app.use(entryChecks);

  const route = (path: string, token: string | undefined, allowed: boolean) => {
    app.all(
      path,
      requires(token),
      express.json({ limit: BODY_LIMIT }),
      badBody,
      (req: Request, res: Response) => {
        void serve(req, res, allowed).catch(() => {
          if (!res.headersSent) refuse(res, 500, 'The server could not handle that request.');
        });
      },
    );
  };

  route(READ_PATH, config.readToken, false);
  if (writes) route(WRITE_PATH, config.writeToken, true);

  // Anything else, including a path that differs from one of those by its
  // case or a trailing slash. It is answered the same way a wrong
  // credential is, so that nobody outside learns which paths exist here,
  // and no body is read on the way.
  app.use((_req: Request, res: Response) => {
    res.setHeader('WWW-Authenticate', 'Bearer');
    refuse(res, 401, 'Missing or wrong bearer token.');
  });

  return app;
}

/**
 * Listen, and resolve once the port is actually bound.
 *
 * The error goes through the callback, not only through an `error` event.
 * Express 5 hands a failed bind to the listening callback, so a server with
 * `server.on('error', reject)` alone resolved on a port that was already
 * taken: the process said it was serving, kept the data directory and the
 * session, and listened to nothing.
 */
export function startHttpServer(config: HttpConfig): Promise<Server> {
  const app = createHttpApp(config);
  return new Promise((resolve, reject) => {
    const server = app.listen(config.port, config.host, (error?: Error) => {
      if (error) reject(error);
      else resolve(server);
    });
    server.on('error', reject);
  });
}
