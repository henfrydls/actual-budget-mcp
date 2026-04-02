import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import * as api from '@actual-app/api';
import { ensureConnection } from '../../connection.js';
import { resolveCategoryId } from '../../utils/resolvers.js';

export function registerDeleteCategory(server: McpServer): void {
  server.tool(
    'delete_category',
    'Delete a budget category. Optionally transfer its transactions to another category.',
    {
      category: z.string().describe('Category name or ID to delete'),
      transfer_to: z.string().optional().describe('Category name or ID to transfer existing transactions to'),
    },
    { destructiveHint: true },
    async ({ category, transfer_to }) => {
      try {
        await ensureConnection();
        const categoryId = await resolveCategoryId(category);

        const categories = await api.getCategories();
        const cat = categories.find((c) => c.id === categoryId);
        const catName = cat?.name || category;

        const transferId = transfer_to ? await resolveCategoryId(transfer_to) : undefined;
        const transferCat = transferId ? categories.find((c) => c.id === transferId) : undefined;

        const result = await api.deleteCategory(categoryId, transferId);
        if (result && (result as any).error) {
          throw new Error(`Delete failed: ${(result as any).error}`);
        }
        await api.sync();

        const lines = [`Category "${catName}" deleted.`];
        if (transferCat) {
          lines.push(`Transactions transferred to: ${transferCat.name}`);
        }

        return { content: [{ type: 'text', text: lines.join('\n') }] };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { content: [{ type: 'text', text: `Error: ${message}` }], isError: true };
      }
    },
  );
}
