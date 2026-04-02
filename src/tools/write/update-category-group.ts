import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import * as api from '@actual-app/api';
import { ensureConnection } from '../../connection.js';
import { resolveCategoryGroupId } from '../../utils/resolvers.js';

export function registerUpdateCategoryGroup(server: McpServer): void {
  server.tool(
    'update_category_group',
    'Rename or hide/unhide a category group.',
    {
      group: z.string().describe('Category group name or ID'),
      name: z.string().optional().describe('New name for the group'),
      hidden: z.boolean().optional().describe('Set to true to hide, false to unhide'),
    },
    { readOnlyHint: false, idempotentHint: true },
    async ({ group, name, hidden }) => {
      try {
        await ensureConnection();
        const groupId = await resolveCategoryGroupId(group);

        const groups = await api.getCategoryGroups();
        const grp = groups.find((g) => g.id === groupId);
        const oldName = grp?.name || group;

        const updates: Record<string, unknown> = {};
        const changes: string[] = [];

        if (name !== undefined) {
          updates.name = name;
          changes.push(`Name: ${oldName} → ${name}`);
        }
        if (hidden !== undefined) {
          updates.hidden = hidden;
          changes.push(`Hidden: ${hidden}`);
        }

        if (changes.length === 0) {
          return { content: [{ type: 'text', text: 'No fields to update.' }], isError: true };
        }

        await api.updateCategoryGroup(groupId, updates as any);
        await api.sync();

        return {
          content: [{
            type: 'text',
            text: `Category group updated:\n${changes.map((c) => `  ${c}`).join('\n')}`,
          }],
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { content: [{ type: 'text', text: `Error: ${message}` }], isError: true };
      }
    },
  );
}
