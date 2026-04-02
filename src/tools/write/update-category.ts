import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import * as api from '@actual-app/api';
import { ensureConnection } from '../../connection.js';
import { resolveCategoryId } from '../../utils/resolvers.js';

export function registerUpdateCategory(server: McpServer): void {
  server.tool(
    'update_category',
    'Rename or hide/unhide a budget category.',
    {
      category: z.string().describe('Category name or ID'),
      name: z.string().optional().describe('New name for the category'),
      hidden: z.boolean().optional().describe('Set to true to hide, false to unhide'),
    },
    { readOnlyHint: false, idempotentHint: true },
    async ({ category, name, hidden }) => {
      try {
        await ensureConnection();
        const categoryId = await resolveCategoryId(category);

        const categories = await api.getCategories();
        const cat = categories.find((c) => c.id === categoryId);
        const oldName = cat?.name || category;

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

        const result = await api.updateCategory(categoryId, updates as any);
        if (result && (result as any).error) {
          throw new Error(`Category update failed: ${JSON.stringify((result as any).error)}`);
        }
        await api.sync();

        return {
          content: [{
            type: 'text',
            text: `Category updated:\n${changes.map((c) => `  ${c}`).join('\n')}`,
          }],
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { content: [{ type: 'text', text: `Error: ${message}` }], isError: true };
      }
    },
  );
}
