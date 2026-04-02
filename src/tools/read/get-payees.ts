import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as api from '@actual-app/api';
import { ensureConnection } from '../../connection.js';
import { sectionHeader } from '../../utils/formatters.js';

export function registerGetPayees(server: McpServer): void {
  server.tool(
    'get_payees',
    'List all payees in the budget. Useful for seeing available payees and their IDs.',
    {},
    { readOnlyHint: true },
    async () => {
      try {
        await ensureConnection();
        const payees = await api.getPayees();

        // Filter out transfer payees (they start with "Transfer:")
        const regularPayees = payees.filter(
          (p) => !p.name.startsWith('Transfer:') && p.name !== '',
        );

        // Sort alphabetically
        regularPayees.sort((a, b) => a.name.localeCompare(b.name));

        const lines: string[] = [
          sectionHeader(`Payees (${regularPayees.length})`),
          '',
        ];

        for (const payee of regularPayees) {
          lines.push(`  ${payee.name} (${payee.id})`);
        }

        return { content: [{ type: 'text', text: lines.join('\n') }] };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: 'text', text: `Error: ${message}` }],
          isError: true,
        };
      }
    },
  );
}
