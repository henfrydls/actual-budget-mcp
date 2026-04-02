import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import * as api from '@actual-app/api';
import { ensureConnection } from '../../connection.js';
import { resolveCategoryGroupId } from '../../utils/resolvers.js';

export function registerCreateCategory(server: McpServer): void {
  server.tool(
    'create_category',
    'Create a new budget category within a category group.',
    {
      name: z.string().describe('Name for the new category'),
      group: z.string().describe('Category group name or ID to add this category to'),
    },
    { readOnlyHint: false },
    async ({ name, group }) => {
      try {
        await ensureConnection();
        const groupId = await resolveCategoryGroupId(group);
        const groups = await api.getCategoryGroups();
        const grp = groups.find((g) => g.id === groupId);

        const id = await api.createCategory({ name, group_id: groupId } as any);
        await api.sync();

        return {
          content: [{
            type: 'text',
            text: `Category created:\n  Name: ${name}\n  Group: ${grp?.name || group}\n  ID: ${id}`,
          }],
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { content: [{ type: 'text', text: `Error: ${message}` }], isError: true };
      }
    },
  );
}
