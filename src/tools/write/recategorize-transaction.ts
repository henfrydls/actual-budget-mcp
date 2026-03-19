import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import * as api from '@actual-app/api';
import { ensureConnection } from '../../connection.js';
import { formatMoney } from '../../utils/money.js';
import { resolveCategoryId } from '../../utils/resolvers.js';

export function registerRecategorizeTransaction(server: McpServer): void {
  server.tool(
    'recategorize_transaction',
    'Change the category of an existing transaction.',
    {
      transaction_id: z.string().describe('Transaction ID'),
      category: z.string().describe('New category name or ID'),
    },
    async ({ transaction_id, category }) => {
      try {
        await ensureConnection();

        const categoryId = await resolveCategoryId(category);

        // Get category name for confirmation
        const categories = await api.getCategories();
        const catEntity = categories.find((c) => c.id === categoryId);
        const catName = catEntity?.name || category;

        await api.updateTransaction(transaction_id, { category: categoryId });
        await api.sync();

        return {
          content: [
            {
              type: 'text',
              text: `Transaction ${transaction_id} recategorized to: ${catName}`,
            },
          ],
        };
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
