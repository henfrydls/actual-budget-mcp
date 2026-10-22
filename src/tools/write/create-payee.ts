import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import * as api from '@actual-app/api';
import { ensureConnection } from '../../connection.js';
import { describeError } from '../../utils/errors.js';
import { syncNow } from '../../utils/sync-clock.js';
import { requireName } from '../../utils/names.js';

export function registerCreatePayee(server: McpServer): void {
  server.tool(
    'create_payee',
    'Create a new payee.',
    {
      name: z.string().describe('Name for the new payee'),
    },
    { title: 'Create payee', readOnlyHint: false },
    async ({ name }) => {
      try {
        await ensureConnection();
        const wanted = requireName(name, 'payee', 'Nothing was created.');
        const id = await api.createPayee({ name: wanted } as any);
        await syncNow();

        return {
          content: [{
            type: 'text',
            text: `Payee created:\n  Name: ${wanted}\n  ID: ${id}`,
          }],
        };
      } catch (error) {
        const message = describeError(error);
        return { content: [{ type: 'text', text: `Error: ${message}` }], isError: true };
      }
    },
  );
}
