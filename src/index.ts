#!/usr/bin/env node

import 'dotenv/config';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { registerAllTools } from './tools/index.js';
import { isReadOnly } from './utils/mode.js';
import { registerAllPrompts } from './prompts.js';
import { registerAllResources } from './resources.js';
import { ensureConnection, shutdown } from './connection.js';
import { installProcessGuards } from './utils/process-guards.js';
import { describeError } from './utils/errors.js';
import * as api from '@actual-app/api';

import { packageVersion } from './utils/version.js';

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

const server = new McpServer({
  name: 'actual-budget-mcp',
  version: packageVersion,
});

registerAllTools(server);
registerAllPrompts(server);
registerAllResources(server);

if (isReadOnly()) {
  // stderr, never stdout: stdout carries JSON-RPC.
  console.error(
    '[actual-budget-mcp] read-only mode: write tools are hidden from discovery. ' +
      'Unset ACTUAL_READ_ONLY to enable them.',
  );
}

const transport = new StdioServerTransport();
await server.connect(transport);

// Validate connection eagerly on startup so config errors surface immediately
// instead of silently failing on the first tool call
try {
  await ensureConnection();
} catch (error) {
  console.error(`Startup validation failed: ${describeError(error)}`);
  // Don't exit — let the MCP server stay alive so the error reaches the client
  // on the first tool call via ensureConnection's error propagation
}

process.on('SIGINT', async () => {
  await shutdown();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  await shutdown();
  process.exit(0);
});
