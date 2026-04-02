import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import * as api from '@actual-app/api';
import { ensureConnection } from '../../connection.js';
import { resolvePayeeId } from '../../utils/resolvers.js';

export function registerUpdatePayee(server: McpServer): void {
  server.tool(
    'update_payee',
    'Rename a payee.',
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
        const message = error instanceof Error ? error.message : String(error);
        return { content: [{ type: 'text', text: `Error: ${message}` }], isError: true };
      }
    },
  );
}
