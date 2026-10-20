import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import * as api from '@actual-app/api';
import { ensureConnection } from '../../connection.js';
import { resolveCategoryId } from '../../utils/resolvers.js';
import { describeError } from '../../utils/errors.js';
import { syncNow } from '../../utils/sync-clock.js';

export function registerUpdateCategory(server: McpServer): void {
  server.tool(
    'update_category',
    'Rename or hide/unhide a budget category.',
    {
      category: z.string().describe('Category name or ID'),
      name: z.string().optional().describe('New name for the category'),
      hidden: z.boolean().optional().describe('Set to true to hide, false to unhide'),
    },
    { title: 'Rename or hide category', readOnlyHint: false, idempotentHint: true },
    async ({ category, name, hidden }) => {
      try {
        await ensureConnection();
        // Including the hidden ones: unhiding a category is this tool's job,
        // and a hidden one does not resolve by name anywhere else (#218).
        const categoryId = await resolveCategoryId(category, { includeHidden: true });

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

        // Actual trims the name without checking there is one, so an update
        // carrying only `hidden` throws on `name.trim()` before anything is
        // written: actualbudget/actual#8857, still there in the 26.11
        // nightly. Sending back the name it already has is what lets a
        // category be hidden from here, and it changes nothing.
        //
        // The name has to come from the budget, never from the argument that
        // named the category: that argument can be an id, and writing it as
        // the name would rename the category to its own id.
        if (updates.name === undefined) {
          if (cat?.name === undefined) {
            throw new Error(
              `Could not read the current name of "${category}", and Actual needs a name ` +
                `on every category update. Nothing was changed.`,
            );
          }
          updates.name = cat.name;
        }

        await api.updateCategory(categoryId, updates as any);
        await syncNow();

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
