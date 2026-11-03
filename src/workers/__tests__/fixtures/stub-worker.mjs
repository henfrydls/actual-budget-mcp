// A worker that is not this server, for the pool's tests.
//
// The pool's contract is "spawn this command and talk MCP to it", so the
// tests give it a command that answers MCP and nothing else: no engine, no
// budget, no network. What varies is told through the environment, which is
// also what lets one of the tests read back exactly what the pool passed.
import { appendFileSync } from 'node:fs';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

const budget = process.env.ACTUAL_BUDGET_ID ?? '(none)';
const server = new McpServer({ name: 'stub-worker', version: '0' });

// What it does is told through argv rather than the environment, because
// the pool builds a worker's environment from an allowlist and these are
// not on it. Which is the point of the allowlist.
const flag = (name) => {
  const found = process.argv.find((arg) => arg.startsWith(`--${name}=`));
  return found === undefined ? undefined : found.slice(name.length + 3);
};
const slow = Number(flag('ready-ms') ?? '0');
const dies = flag('die');
const bigBytes = Number(flag('big-bytes') ?? '0');
const slowCall = Number(flag('slow-call-ms') ?? '0');
// Where to write down that a call arrived, so that a test can count the
// attempts a worker that dies mid-call would otherwise take with it.
const countFile = flag('count-file');

// `registerTool` rather than `tool`: the latter guesses which overload it
// was called with, and a tool that takes no arguments gives it nothing to
// guess from.
server.registerTool(
  'list_accounts',
  { description: 'the readiness probe', annotations: { readOnlyHint: true } },
  async () => {
    if (slow > 0) await new Promise((resolve) => setTimeout(resolve, slow));
    return { content: [{ type: 'text', text: `accounts of ${budget}` }] };
  },
);

server.registerTool(
  'get_budget_month',
  { description: 'a read', annotations: { readOnlyHint: true } },
  async () => {
    if (countFile !== undefined) appendFileSync(countFile, `read in ${budget}\n`);
    if (dies === 'read') process.exit(1);
    if (bigBytes > 0) {
      return { content: [{ type: 'text', text: 'x'.repeat(bigBytes) }] };
    }
    if (slowCall > 0) await new Promise((resolve) => setTimeout(resolve, slowCall));
    return { content: [{ type: 'text', text: `month of ${budget}` }] };
  },
);

server.registerTool('create_transaction', { description: 'a write' }, async () => {
  if (countFile !== undefined) appendFileSync(countFile, `write in ${budget}\n`);
  if (dies === 'write') process.exit(1);
  return { content: [{ type: 'text', text: `written in ${budget}` }] };
});

server.registerTool(
  'echo_env',
  { description: 'what this process was given', annotations: { readOnlyHint: true } },
  async () => ({ content: [{ type: 'text', text: JSON.stringify(process.env) }] }),
);

// Something on stderr, so the pipe that prefixes and redacts it has
// something to carry.
console.error(`stub worker up for ${budget} at http://user:hunter2@actual.example:5006`);

await server.connect(new StdioServerTransport());
