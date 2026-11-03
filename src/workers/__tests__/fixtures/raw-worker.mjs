// A worker that speaks the protocol by hand, so that a test can make it
// answer things the SDK's server would never produce.
//
// The one that matters here: a JSON-RPC error whose message says the
// connection closed, from a process that is alive and goes on running. The
// SDK's own server turns a thrown handler into an `isError` result, so
// there is no way to get a rejected `callTool` out of it without killing
// the process, and "believed gone while still running" is exactly the case
// the pool has to get right.
import { appendFileSync } from 'node:fs';

const flag = (name) => {
  const found = process.argv.find((arg) => arg.startsWith(`--${name}=`));
  return found === undefined ? undefined : found.slice(name.length + 3);
};

const pidFile = flag('pid-file');
if (pidFile !== undefined) appendFileSync(pidFile, `${process.pid}\n`);

/** What every `tools/call` answers with. */
const errorMessage = flag('call-error') ?? 'Connection closed';

const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);

let rest = '';
process.stdin.on('data', (chunk) => {
  const lines = (rest + String(chunk)).split('\n');
  rest = lines.pop() ?? '';
  for (const line of lines) {
    if (line.trim() === '') continue;
    let request;
    try {
      request = JSON.parse(line);
    } catch {
      continue;
    }
    if (request.id === undefined) continue; // a notification

    if (request.method === 'initialize') {
      send({
        jsonrpc: '2.0',
        id: request.id,
        result: {
          protocolVersion: request.params?.protocolVersion ?? '2025-06-18',
          capabilities: { tools: {} },
          serverInfo: { name: 'raw-worker', version: '0' },
        },
      });
      continue;
    }

    if (request.method === 'tools/list') {
      send({
        jsonrpc: '2.0',
        id: request.id,
        result: {
          tools: [
            {
              name: 'get_budget_month',
              description: 'a read',
              inputSchema: { type: 'object', properties: {} },
            },
            { name: 'list_accounts', description: 'the probe', inputSchema: { type: 'object' } },
          ],
        },
      });
      continue;
    }

    if (request.method === 'tools/call') {
      // The probe has to succeed, or the pool never calls anything.
      if (request.params?.name === 'list_accounts') {
        send({
          jsonrpc: '2.0',
          id: request.id,
          result: { content: [{ type: 'text', text: 'accounts' }] },
        });
        continue;
      }
      send({ jsonrpc: '2.0', id: request.id, error: { code: -32603, message: errorMessage } });
      continue;
    }

    send({ jsonrpc: '2.0', id: request.id, result: {} });
  }
});

// Alive until its stdin ends, which is how the pool closes a worker.
process.stdin.on('end', () => process.exit(0));
