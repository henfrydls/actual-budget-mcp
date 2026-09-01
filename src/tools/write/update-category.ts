import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import * as api from '@actual-app/api';
import { ensureConnection } from '../../connection.js';
import { resolveCategoryId } from '../../utils/resolvers.js';
import { describeError } from '../../utils/errors.js';

export function registerUpdateCategory(server: McpServer): void {
  server.tool(
    'update_category',
    'Rename a category, or hide it with hidden: true. Hiding is the non-destructive '
      + 'way to retire a category you no longer use: it disappears from the budget while '
      + 'its history, budgeted amounts and rollover stay intact, and it can be unhidden '
      + 'later. Prefer it to delete_category, which destroys that history for good.',
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

        await api.updateCategory(categoryId, updates as any);
        await api.sync();

        return {
          content: [{
            type: 'text',
            text: `Category updated:\n${changes.map((c) => `  ${c}`).join('\n')}`,
          }],
        };
      } catch (error) {
        const message = describeError(error);
        return { content: [{ type: 'text', text: `Error: ${message}` }], isError: true };
      }
    },
  );
}
