#!/usr/bin/env node

import 'dotenv/config';
// Before anything that imports `@actual-app/api`: the bundle captures
// `globalThis.fetch` when it loads, so a wrapper installed later is never
// seen. Gives every SDK request a deadline it otherwise does not have (#99).
import './utils/http-timeout.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createMcpServer } from './mcp-server.js';
import { isReadOnly } from './utils/mode.js';
import { chosenToolset, unrecognisedToolset } from './utils/toolset.js';
import {
  httpRequested,
  httpHalfConfigured,
  readHttpConfig,
  displayHost,
  READ_PATH,
  WRITE_PATH,
} from './utils/http-config.js';
import { startHttpServer } from './http.js';
import { connectionSettled, ensureConnection, shutdown } from './connection.js';
import { installExitPaths } from './utils/orderly-exit.js';
import { startLeaving, whenIdle } from './utils/in-flight.js';
import { installProcessGuards } from './utils/process-guards.js';
import { describeError } from './utils/errors.js';
import * as api from '@actual-app/api';

import { packageVersion } from './utils/version.js';
import { ensureNativeBinding } from './utils/native-binding.js';
import { assertSupportedRuntime } from './utils/runtime-check.js';

// Redirect console.log/warn/info to stderr so they don't contaminate
// the MCP JSON-RPC protocol on stdout. Libraries like @actual-app/api
// print debug messages (e.g., [Breadcrumb], "Syncing...") to stdout
// via console.log, which breaks MCP clients like Claude Desktop.
const originalLog = console.log;
const originalInfo = console.info;
const originalWarn = console.warn;
console.log = (...args: unknown[]) => console.error(...args);
console.info = (...args: unknown[]) => console.error(...args);
console.warn = (...args: unknown[]) => console.error(...args);

// #39: keep a rejection from inside @actual-app/api (e.g. a failed budget
// download) from killing the process under Node's default
// --unhandled-rejections=throw (the default since Node 15). Installed before
// anything that can reject — including --verify, which awaits the very call
// whose stray rejections motivated this.
installProcessGuards();


// --version / -v: answered before anything else, and before any config is
// required. Typing it used to fall through to startup validation and print
// "Missing required environment variables", which answers a question nobody
// asked and hides the one they did.
if (process.argv.includes('--version') || process.argv.includes('-v')) {
  originalLog(packageVersion);
  process.exit(0);
}

// Which runtime is actually running this, and which SQLite binary it will use.
// One line on stderr, where MCP clients keep their logs. It is the first thing
// a bug report needs and the one thing the reporter cannot look up: the ABI
// decides whether the bundled binary can load at all, and a host that ships its
// own Node does not advertise which one.
//
// Runs before any database is opened. `bindings` resolves the binary lazily,
// inside the Database constructor, so this is early enough by a wide margin.
// Before the binding, and before anything can open a database: under Node
// older than 22.14 the SQLite binary segfaults instead of failing, so there is
// nothing to report afterwards. Measured on 22.13.1: exit 139, no message.
assertSupportedRuntime();

const binding = ensureNativeBinding();
console.error(
  `[actual-budget-mcp] ${packageVersion} on node ${process.version} ` +
    `(abi ${process.versions.modules}, napi ${process.versions.napi ?? '?'}, ` +
    `${process.platform}-${process.arch}) ` +
    // `abi-install`, not `sqlite`. What this reports is whether an ABI-keyed
    // binary was copied into place, which from better-sqlite3 13 never happens
    // and never needs to: the binaries are N-API and the package resolves its
    // own. Labelled `sqlite=not-bundled`, it read as "this build has no SQLite"
    // on a bundle carrying eight binaries -- and people paste this line into
    // issues, so it has to be true on its face.
    `exec=${process.execPath} abi-install=${binding.status}` +
    (binding.detail ? ` (${binding.detail})` : ''),
);

// --verify flag: test connection and exit (restore stdout for user output)
if (process.argv.includes('--verify')) {
  console.log = originalLog;
  console.info = originalInfo;
  console.warn = originalWarn;
  try {
    console.log('Verifying connection to Actual Budget...\n');
    await ensureConnection();
    const accounts = await api.getAccounts();
    const open = accounts.filter((a) => !a.closed);
    const groups = await api.getCategoryGroups();
    console.log(`Connected successfully!`);
    console.log(`  Accounts: ${open.length}`);
    console.log(`  Category groups: ${groups.length}`);
    console.log('\nYour MCP server is ready to use.');
    await shutdown();
    process.exit(0);
  } catch (error) {
    console.error(`Connection failed: ${describeError(error)}`);
    process.exit(1);
  }
}

// HTTP is opt-in and stdio is the default: setting a port is what asks for
// it (#228). The configuration is checked before anything is registered or
// opened, and every reason it cannot be served is printed at once, because a
// deployment corrected one line at a time with a restart between each is how
// an operator ends up guessing.
const overHttp = httpRequested();
// A token and a host set, and no port: that is an HTTP deployment with one
// line missing, and starting quietly on stdio answers nothing and looks
// like the server is up.
const halfConfigured = httpHalfConfigured();
if (halfConfigured.length > 0) {
  console.error(
    `[actual-budget-mcp] ${halfConfigured.join(', ')} ${halfConfigured.length === 1 ? 'is' : 'are'} ` +
      'set and ACTUAL_HTTP_PORT is not, so there is nothing to serve them on. Set a port, ' +
      'or unset these to run over stdio.',
  );
  process.exit(1);
}
const http = overHttp ? readHttpConfig() : undefined;
if (http !== undefined && http.config === undefined) {
  for (const problem of http.problems) {
    console.error(`[actual-budget-mcp] ${problem}`);
  }
  process.exit(1);
}

if (isReadOnly()) {
  // stderr, never stdout: stdout carries JSON-RPC.
  console.error(
    '[actual-budget-mcp] read-only mode: write tools are hidden from discovery. ' +
      'Unset ACTUAL_READ_ONLY to enable them.',
  );
}

const unrecognised = unrecognisedToolset();
if (unrecognised !== undefined) {
  console.error(
    `[actual-budget-mcp] ACTUAL_TOOLSET is "${unrecognised}", which is not "chat" or ` +
      '"full". Offering every tool.',
  );
}

if (chosenToolset() === 'chat') {
  // Said for the same reason the line above is: a tool that is missing
  // because of a setting looks exactly like a tool that is missing because
  // something is broken, and only one of those is worth investigating.
  console.error(
    '[actual-budget-mcp] chat toolset: the everyday tools are offered and the ones for ' +
      'setting up and repairing a budget are not. Set ACTUAL_TOOLSET=full for all of them.',
  );
}

// Signals, and the way a stdio client really leaves: end-of-file on stdin.
// Nothing watched for that, so a client that went away left this process
// running with its data directory held (#207), and from Actual 26.11 with a
// session on the server that nothing ever clears (#219).
//
// Before the budget is opened, not after: the first download can take
// minutes, a client that gives up during it closes stdin, and a listener
// registered afterwards never hears the event that already happened.
// Measured: ending stdin while the budget was still downloading left the
// process running until it was killed.
installExitPaths({
  stop: shutdown,
  // Tool calls and the first connection both count as work in flight: one
  // must not be cut in half, and the other is what opened the session that
  // the shutdown is there to close.
  whenIdle: async () => {
    await Promise.all([whenIdle(), connectionSettled()]);
  },
  // Nothing new from the moment the exit starts, so a request still in the
  // pipe is refused instead of reaching a budget that is being closed.
  stopAccepting: startLeaving,
  exit: (code) => process.exit(code),
  // Only stdio leaves that way. An HTTP server's clients arrive and go over
  // the network, and a container started detached has no stdin at all.
  stdin: overHttp ? undefined : process.stdin,
  signals: process,
});

if (http?.config !== undefined) {
  const config = http.config;
  await startHttpServer(config);
  console.error(
    `[actual-budget-mcp] HTTP on http://${displayHost(config.host)}:${config.port}, ` +
      `${READ_PATH} reads` +
      (config.writeToken === undefined
        ? ' and nothing writes: set ACTUAL_HTTP_WRITE_TOKEN for a write path'
        : `, ${WRITE_PATH} writes`),
  );
} else {
  const transport = new StdioServerTransport();
  await createMcpServer().connect(transport);
}

// Validate connection eagerly on startup so config errors surface immediately
// instead of silently failing on the first tool call
try {
  await ensureConnection();
} catch (error) {
  console.error(`Startup validation failed: ${describeError(error)}`);
  // Don't exit — let the MCP server stay alive so the error reaches the client
  // on the first tool call via ensureConnection's error propagation
}

