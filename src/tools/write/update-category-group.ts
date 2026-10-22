import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import * as api from '@actual-app/api';
import { ensureConnection } from '../../connection.js';
import { resolveCategoryGroupId } from '../../utils/resolvers.js';
import { describeError } from '../../utils/errors.js';
import { syncNow } from '../../utils/sync-clock.js';
import { requireName } from '../../utils/names.js';

export function registerUpdateCategoryGroup(server: McpServer): void {
  server.tool(
    'update_category_group',
    'Rename or hide/unhide a category group.',
    {
      group: z.string().describe('Category group name or ID'),
      name: z.string().optional().describe('New name for the group'),
      hidden: z.boolean().optional().describe('Set to true to hide, false to unhide'),
    },
    { title: 'Rename or hide category group', readOnlyHint: false, idempotentHint: true },
    async ({ group, name, hidden }) => {
      try {
        await ensureConnection();
        const wanted =
          name === undefined
            ? undefined
            : requireName(name, 'category group', 'Nothing was changed.');
        const groupId = await resolveCategoryGroupId(group);

        const groups = await api.getCategoryGroups();
        const grp = groups.find((g) => g.id === groupId);
        const oldName = grp?.name || group;

        const updates: Record<string, unknown> = {};
        const changes: string[] = [];

        if (wanted !== undefined) {
          updates.name = wanted;
          changes.push(`Name: ${oldName} → ${wanted}`);
        }
        if (hidden !== undefined) {
          updates.hidden = hidden;
          changes.push(`Hidden: ${hidden}`);
        }

        if (changes.length === 0) {
          return { content: [{ type: 'text', text: 'No fields to update.' }], isError: true };
        }

        // Actual needs a name on every group update, whatever else is being
        // changed. `db.updateCategoryGroup` opens by looking for another
        // group with the same name, `group.name.toUpperCase()`, without
        // checking there is one, so hiding a group without renaming it threw
        // `Cannot read properties of undefined (reading 'toUpperCase')` and
        // wrote nothing (#260). It is the same shape as
        // actualbudget/actual#8857, which `update_category` already works
        // around the same way.
        //
        // The name comes from the budget, never from the argument that named
        // the group: that argument can be an id, and writing it as the name
        // would rename the group to its own id.
        if (updates.name === undefined) {
          if (grp?.name === undefined) {
            throw new Error(
              `Could not read the current name of "${group}", and Actual needs a name on ` +
                `every category group update. Nothing was changed.`,
            );
          }
          updates.name = grp.name;
        }

        await api.updateCategoryGroup(groupId, updates as any);
        await syncNow();

        return {
          content: [{
            type: 'text',
            text: `Category group updated:\n${changes.map((c) => `  ${c}`).join('\n')}`,
          }],
        };
      } catch (error) {
        const message = describeError(error);
        return { content: [{ type: 'text', text: `Error: ${message}` }], isError: true };
      }
    },
  );
}
