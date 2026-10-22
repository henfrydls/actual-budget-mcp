import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerAllTools } from './tools/index.js';
import { registerAllPrompts } from './prompts.js';
import { registerAllResources } from './resources.js';
import { serverInstructions } from './utils/instructions.js';
import { isReadOnly } from './utils/mode.js';
import { packageVersion } from './utils/version.js';

/**
 * One configured MCP server, built the same way wherever it is used (#228).
 *
 * stdio builds one of these and keeps it for the life of the process. HTTP
 * builds one per request, because a stateless transport has no session to
 * hold one in, and because the read path and the write path are the same
 * process with different tools registered.
 *
 * Building one is registration and nothing else: no connection is opened, no
 * budget is touched, and the engine behind the tools is shared by every
 * server this makes. It is the list of what can be called, not a second copy
 * of anything.
 */
export function createMcpServer(options: { readOnly?: boolean } = {}): McpServer {
  const readOnly = options.readOnly ?? isReadOnly();

  const server = new McpServer(
    { name: 'actual-budget-mcp', version: packageVersion },
    // What the protocol calls instructions: the conventions that hold across
    // the tools, said once at connection rather than inferred from forty
    // descriptions (#222). Read-only drops the paragraphs about writing,
    // which describe tools this server does not have.
    { instructions: serverInstructions({ readOnly }) },
  );

  registerAllTools(server, { readOnly });
  // Prompts ask the tool registry what was offered, which is a module-level
  // record overwritten by the call above. That holds because building a
  // server is synchronous from end to end: nothing can register tools
  // between these two lines.
  registerAllPrompts(server);
  registerAllResources(server);

  return server;
}
