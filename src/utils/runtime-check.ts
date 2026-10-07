/**
 * Refuse a Node too old for the SQLite binary, before it dies without a word.
 *
 * `better-sqlite3` 13 is built against N-API 10, which arrives in Node 22.14.
 * On anything older the binary loads and then **segfaults**: measured on
 * 22.13.1, `new Database(':memory:')` exits 139 with no message, no stack and
 * nothing in any log. A host that restarts the server would do it forever.
 *
 * The check is on N-API rather than on the version string, because that is the
 * actual requirement: it is what the binary was compiled against, and it is
 * what moves if better-sqlite3 raises it again.
 *
 * It runs before anything opens a database, which is possible because the
 * binding is lazy — importing `@actual-app/api` under 22.13.1 is fine, and only
 * the first `Database` is not.
 */

/** What `better-sqlite3` 13 is built against. */
export const REQUIRED_NAPI = 10;

/** The first Node that reports it. */
export const MINIMUM_NODE = '22.14.0';

/**
 * The message for this runtime, or nothing when it can run.
 *
 * Pure so it can be tested on versions this machine does not have.
 */
export function unsupportedRuntimeMessage(
  napi: string | undefined,
  nodeVersion: string,
): string | undefined {
  // Absent rather than old: every Node that can run this reports it, so the
  // safe reading is "not a Node we know" and the safe action is to let it try.
  if (napi === undefined) return undefined;
  const reported = Number(napi);
  if (!Number.isFinite(reported) || reported >= REQUIRED_NAPI) return undefined;

  return (
    `This server needs Node ${MINIMUM_NODE} or newer and is running on ${nodeVersion}. ` +
    `Its SQLite library is built against N-API ${REQUIRED_NAPI} and this Node reports ` +
    `${reported}, which does not fail cleanly: opening the budget would crash the ` +
    'process with no message at all. Update Node, or run the published Docker image, ' +
    'which carries its own.'
  );
}

/**
 * Says it on stderr and stops, rather than letting the crash happen.
 *
 * Exits rather than throwing: a throw here would be caught by the startup
 * guards and reported as a connection problem, which is the wrong story.
 */
export function assertSupportedRuntime(): void {
  const message = unsupportedRuntimeMessage(process.versions.napi, process.version);
  if (!message) return;
  // stderr: stdout carries JSON-RPC.
  console.error(`[actual-budget-mcp] ${message}`);
  process.exit(1);
}
