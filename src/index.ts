#!/usr/bin/env node

import 'dotenv/config';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { registerAllTools } from './tools/index.js';
import { ensureConnection, shutdown } from './connection.js';
import * as api from '@actual-app/api';

// --verify flag: test connection and exit
if (process.argv.includes('--verify')) {
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
  version: '0.1.0',
});

registerAllTools(server);

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
