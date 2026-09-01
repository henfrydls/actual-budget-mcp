import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import * as api from '@actual-app/api';
import { ensureConnection } from '../../connection.js';
import { describeError } from '../../utils/errors.js';

export function registerCreateCategoryGroup(server: McpServer): void {
  server.tool(
    'create_category_group',
    'Create a category group, the heading that categories are filed under (for example '
      + '"Fixed Costs" or "Savings"). Groups hold no money themselves: they total up the '
      + 'categories inside them. Create the group before the categories that belong to it.',
    {
      name: z.string().describe('Name for the new category group'),
    },
    { readOnlyHint: false },
    async ({ name }) => {
      try {
        await ensureConnection();
        const id = await api.createCategoryGroup({ name } as any);
        await api.sync();

        return {
          content: [{
            type: 'text',
            text: `Category group created:\n  Name: ${name}\n  ID: ${id}`,
          }],
        };
      } catch (error) {
        const message = describeError(error);
        return { content: [{ type: 'text', text: `Error: ${message}` }], isError: true };
      }
    },
  );
}
