import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import * as api from '@actual-app/api';
import { ensureConnection } from '../../connection.js';
import { resolvePayeeId } from '../../utils/resolvers.js';

export function registerDeletePayee(server: McpServer): void {
  server.tool(
    'delete_payee',
    'Delete a payee.',
    {
      payee: z.string().describe('Payee name or ID to delete'),
    },
    { destructiveHint: true },
    async ({ payee }) => {
      try {
        await ensureConnection();
        const payeeId = await resolvePayeeId(payee);

        const payees = await api.getPayees();
        const p = payees.find((x) => x.id === payeeId);
        const payeeName = p?.name || payee;

        await api.deletePayee(payeeId);
        await api.sync();

        return {
          content: [{
            type: 'text',
            text: `Payee "${payeeName}" deleted.`,
          }],
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { content: [{ type: 'text', text: `Error: ${message}` }], isError: true };
      }
    },
  );
}
