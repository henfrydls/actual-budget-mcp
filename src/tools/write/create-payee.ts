import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import * as api from '@actual-app/api';
import { ensureConnection } from '../../connection.js';
import { describeError } from '../../utils/errors.js';

export function registerCreatePayee(server: McpServer): void {
  server.tool(
    'create_payee',
    'Create a payee. Payees are usually created automatically when a transaction '
      + 'names one, so reach for this only when you need the payee to exist up front — '
      + 'for example before writing a rule that targets it. Actual does not merge by '
      + 'name, so calling this with a name that already exists leaves you with two '
      + 'payees; check get_payees first.',
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
        const message = describeError(error);
        return { content: [{ type: 'text', text: `Error: ${message}` }], isError: true };
      }
    },
  );
}
