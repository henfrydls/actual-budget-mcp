#!/usr/bin/env node

import 'dotenv/config';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { registerAllTools } from './tools/index.js';
import { registerAllPrompts } from './prompts.js';
import { registerAllResources } from './resources.js';
import { ensureConnection, shutdown } from './connection.js';
import * as api from '@actual-app/api';

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
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Connection failed: ${message}`);
    process.exit(1);
  }
}

const server = new McpServer({
  name: 'actual-budget-mcp',
  version: '0.3.0',
});

registerAllTools(server);
registerAllPrompts(server);
registerAllResources(server);

const transport = new StdioServerTransport();
await server.connect(transport);

process.on('SIGINT', async () => {
  await shutdown();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  await shutdown();
  process.exit(0);
});
