import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import * as api from '@actual-app/api';
import { ensureConnection } from '../../connection.js';
import { describeError } from '../../utils/errors.js';

export function registerDeleteRule(server: McpServer): void {
  server.tool(
    'delete_rule',
    'Delete a transaction rule by its ID.',
    {
      rule_id: z.string().describe('Rule ID to delete'),
    },
    { destructiveHint: true },
    async ({ rule_id }) => {
      try {
        await ensureConnection();
        const result = await api.deleteRule(rule_id);
        await api.sync();

        if (result) {
          return { content: [{ type: 'text', text: `Rule ${rule_id} deleted.` }] };
        } else {
          return { content: [{ type: 'text', text: `Rule ${rule_id} not found.` }], isError: true };
        }
      } catch (error) {
        const message = describeError(error);
        return { content: [{ type: 'text', text: `Error: ${message}` }], isError: true };
      }
    },
  );
}
