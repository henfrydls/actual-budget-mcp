import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import * as api from '@actual-app/api';
import { ensureConnection } from '../../connection.js';
import { formatMoney } from '../../utils/money.js';
import { resolveCategoryId } from '../../utils/resolvers.js';
import { describeError } from '../../utils/errors.js';
import { updatePreservingChildAmount } from '../../utils/transactions.js';

export function registerRecategorizeTransaction(server: McpServer): void {
  server.tool(
    'recategorize_transaction',
    'Change which category a transaction counts against, leaving its amount, date and '
      + 'payee untouched. This is the tool for fixing a miscategorised expense. It is '
      + 'safe on a split child: the amount is preserved, so the split keeps adding up to '
      + 'its parent. To change anything other than the category, use update_transaction.',
    {
      transaction_id: z.string().describe('Transaction ID'),
      category: z.string().describe('New category name or ID'),
    },
    { readOnlyHint: false, idempotentHint: true },
    async ({ transaction_id, category }) => {
      try {
        await ensureConnection();

        const categoryId = await resolveCategoryId(category);

        // Get category name for confirmation
        const categories = await api.getCategories();
        const catEntity = categories.find((c) => c.id === categoryId);
        const catName = catEntity?.name || category;

        // #44: routed through the guard so recategorizing a split child does
        // not reset its amount to 0 and unbalance the parent.
        await updatePreservingChildAmount(transaction_id, { category: categoryId });
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
        const message = describeError(error);
        return {
          content: [{ type: 'text', text: `Error: ${message}` }],
          isError: true,
        };
      }
    },
  );
}
