import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import * as api from '@actual-app/api';
import { ensureConnection } from '../../connection.js';

export function registerCreatePayee(server: McpServer): void {
  server.tool(
    'create_payee',
    'Create a new payee.',
    {
      name: z.string().describe('Name for the new payee'),
    },
    { readOnlyHint: false },
    async ({ name }) => {
      try {
        await ensureConnection();
        const id = await api.createPayee({ name } as any);
        await api.sync();

        return {
          content: [{
            type: 'text',
            text: `Payee created:\n  Name: ${name}\n  ID: ${id}`,
          }],
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { content: [{ type: 'text', text: `Error: ${message}` }], isError: true };
      }
    },
  );
}
