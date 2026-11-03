// A worker that is not this server, for the pool's tests.
//
// The pool's contract is "spawn this command and talk MCP to it", so the
// tests give it a command that answers MCP and nothing else: no engine, no
// budget, no network. What varies is told through the environment, which is
// also what lets one of the tests read back exactly what the pool passed.
import { appendFileSync, existsSync, writeFileSync } from 'node:fs';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

const budget = process.env.ACTUAL_BUDGET_ID ?? '(none)';
// The capability is declared the way the real worker declares it: only when
// the pool put its marker in this process's environment. A test that sets
// --report-name and sees nothing arrive is a test that the marker did not.
const server = new McpServer(
  { name: 'stub-worker', version: '0' },
  process.env.ACTUAL_MCP_WORKER === '1' ? { capabilities: { logging: {} } } : {},
);

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
// Where to write down that this process exists, so a test can tell how many
// were started and whether any outlived the pool.
const pidFile = flag('pid-file');
if (pidFile !== undefined) appendFileSync(pidFile, `${process.pid}\n`);
// Die on the first read only: the file is the memory the dead process does
// not have, so a replacement started by the pool answers normally.
const dieOnce = flag('die-once');
// A write that takes longer than the front end waits.
const slowWrite = Number(flag('slow-write-ms') ?? '0');
// Something on stderr with no newline behind it, for the flush on close.
const lastWord = flag('last-word');
// And something on stdout that is not a message, which is how a transport
// reports an error about a process that is alive and well. Written when a
// tool is called, rather than at startup, so that it arrives after the pool
// has installed its own handlers and not during the handshake.
const junkLine = process.argv.includes('--junk-line');

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
    if (junkLine) process.stdout.write('this is not json\n');
    if (countFile !== undefined) appendFileSync(countFile, `read in ${budget}\n`);
    if (dies === 'read') process.exit(1);
    if (dieOnce !== undefined && !existsSync(dieOnce)) {
      writeFileSync(dieOnce, 'died once');
      process.exit(1);
    }
    if (bigBytes > 0) {
      return { content: [{ type: 'text', text: 'x'.repeat(bigBytes) }] };
    }
    if (slowCall > 0) await new Promise((resolve) => setTimeout(resolve, slowCall));
    return { content: [{ type: 'text', text: `month of ${budget}` }] };
  },
);

server.registerTool('create_transaction', { description: 'a write' }, async () => {
  if (dies === 'write') {
    if (countFile !== undefined) appendFileSync(countFile, `write in ${budget}\n`);
    process.exit(1);
  }
  if (slowWrite > 0) await new Promise((resolve) => setTimeout(resolve, slowWrite));
  // After the wait, so that the file says when it was applied rather than
  // when it was asked for.
  if (countFile !== undefined) appendFileSync(countFile, `write in ${budget}\n`);
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

// What this worker says about its budget, once it is connected.
const reportName = flag('report-name');
const reportId = flag('report-id');
const reportLogger = flag('report-logger');

await server.connect(new StdioServerTransport());

if (reportName !== undefined) {
  await server.server.sendLoggingMessage({
    level: 'info',
    logger: reportLogger ?? 'actual-budget-mcp/worker',
    data: {
      budgetId: reportId ?? budget,
      name: reportName === 'TOO-LONG' ? 'x'.repeat(201) : reportName,
    },
  });
}

// Last, and with no newline after it: what a process says on its way out,
// which is the half that used to be dropped.
if (lastWord !== undefined) process.stderr.write(lastWord);
