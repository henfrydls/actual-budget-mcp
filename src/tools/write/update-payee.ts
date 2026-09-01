import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import * as api from '@actual-app/api';
import { ensureConnection } from '../../connection.js';
import { resolvePayeeId } from '../../utils/resolvers.js';
import { describeError } from '../../utils/errors.js';

export function registerUpdatePayee(server: McpServer): void {
  server.tool(
    'update_payee',
    'Rename a payee, on every transaction that uses it at once. Use this to fix a '
      + 'messy imported name rather than editing transactions one by one. Renaming to a '
      + 'name that already exists does not merge the two payees.',
    {
      payee: z.string().describe('Payee name or ID'),
      name: z.string().describe('New name for the payee'),
    },
    { readOnlyHint: false, idempotentHint: true },
    async ({ payee, name }) => {
      try {
        await ensureConnection();
        const payeeId = await resolvePayeeId(payee);

        const payees = await api.getPayees();
        const p = payees.find((x) => x.id === payeeId);
        const oldName = p?.name || payee;

        await api.updatePayee(payeeId, { name } as any);
        await api.sync();

        return {
          content: [{
            type: 'text',
            text: `Payee renamed: ${oldName} → ${name}`,
          }],
        };
      } catch (error) {
        const message = describeError(error);
        return { content: [{ type: 'text', text: `Error: ${message}` }], isError: true };
      }
    },
  );
}
