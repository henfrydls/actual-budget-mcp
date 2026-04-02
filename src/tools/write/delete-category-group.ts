import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import * as api from '@actual-app/api';
import { ensureConnection } from '../../connection.js';
import { resolveCategoryGroupId, resolveCategoryId } from '../../utils/resolvers.js';

export function registerDeleteCategoryGroup(server: McpServer): void {
  server.tool(
    'delete_category_group',
    'Delete a category group. You must specify a category to transfer orphaned categories\' transactions to.',
    {
      group: z.string().describe('Category group name or ID to delete'),
      transfer_to: z.string().describe('Category name or ID to transfer orphaned transactions to'),
    },
    { destructiveHint: true },
    async ({ group, transfer_to }) => {
      try {
        await ensureConnection();
        const groupId = await resolveCategoryGroupId(group);
        const transferId = await resolveCategoryId(transfer_to);

        const groups = await api.getCategoryGroups();
        const grp = groups.find((g) => g.id === groupId);
        const groupName = grp?.name || group;

        const categories = await api.getCategories();
        const transferCat = categories.find((c) => c.id === transferId);

        await api.deleteCategoryGroup(groupId, transferId);
        await api.sync();

        return {
          content: [{
            type: 'text',
            text: `Category group "${groupName}" deleted.\nTransactions transferred to: ${transferCat?.name || transfer_to}`,
          }],
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { content: [{ type: 'text', text: `Error: ${message}` }], isError: true };
      }
    },
  );
}
