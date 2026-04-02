import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import * as api from '@actual-app/api';
import { ensureConnection } from '../../connection.js';

export function registerCreateCategoryGroup(server: McpServer): void {
  server.tool(
    'create_category_group',
    'Create a new category group for organizing budget categories.',
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
        const message = error instanceof Error ? error.message : String(error);
        return { content: [{ type: 'text', text: `Error: ${message}` }], isError: true };
      }
    },
  );
}
