#!/usr/bin/env node
// What a client is sent on connection, per toolset (#222).
//
// The figures in the README come from here rather than from an estimate: the
// real tools, registered into a real `McpServer`, asked through a real client
// for `tools/list`, and the bytes counted off the wire.
//
//   npm run build && node scripts/measure-toolset.mjs
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { registerAllTools } from '../dist/tools/index.js';

async function measure(env) {
  for (const key of ['ACTUAL_TOOLSET', 'ACTUAL_READ_ONLY']) delete process.env[key];
  Object.assign(process.env, env);

  const server = new McpServer({ name: 'actual-budget-mcp', version: '0.0.0' });
  registerAllTools(server);
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'measure', version: '0' }, { capabilities: {} });
  await Promise.all([server.connect(b), client.connect(a)]);

  const { tools } = await client.listTools();
  const bytes = Buffer.byteLength(JSON.stringify({ tools }), 'utf8');
  await client.close();
  return { tools: tools.length, bytes };
}

const rows = [
  ['full (default)', {}],
  ['chat', { ACTUAL_TOOLSET: 'chat' }],
  ['chat with ACTUAL_READ_ONLY=1', { ACTUAL_TOOLSET: 'chat', ACTUAL_READ_ONLY: '1' }],
  ['full with ACTUAL_READ_ONLY=1', { ACTUAL_READ_ONLY: '1' }],
];

console.log('| `ACTUAL_TOOLSET` | Tools | `tools/list` |');
console.log('|---|---|---|');
for (const [label, env] of rows) {
  const { tools, bytes } = await measure(env);
  console.log(`| ${label} | ${tools} | ${(bytes / 1024).toFixed(1)} KiB (${bytes} bytes) |`);
}
process.exit(0);
