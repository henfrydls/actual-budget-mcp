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
        const was = grp as { name?: string; hidden?: boolean } | undefined;

        if (wanted !== undefined) updates.name = wanted;
        if (hidden !== undefined) updates.hidden = hidden;
        const changes = Object.keys(updates).length;

        if (changes === 0) {
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

        // Read back and named, the way `update_category` answers since #237
        // (#266). "Category group updated: Hidden: true" did not say which
        // group, and by id that was the only place to find out.
        const after = ((await api.getCategoryGroups()) as unknown as Array<{
          id: string;
          name: string;
          hidden?: boolean;
        }>).find((g) => g.id === groupId);
        if (!after) {
          throw new Error(
            `"${group}" was updated but is no longer in the budget, which should not happen. ` +
              `Check it in Actual before doing anything else.`,
          );
        }

        const rows: string[] = [];
        let moved = false;
        const row = (label: string, text: string) => rows.push(`  ${label.padEnd(6)} ${text}`);

        if (name !== undefined) {
          if (was?.name !== after.name) {
            moved = true;
            row('Name', `${was?.name ?? '(unknown)'} -> ${after.name}`);
          } else {
            row('Name', `${after.name} (already that)`);
          }
        }
        if (hidden !== undefined) {
          const before = Boolean(was?.hidden);
          const now = Boolean(after.hidden);
          if (before !== now) {
            moved = true;
            row('Hidden', `${before} -> ${now}`);
          } else {
            row('Hidden', `${now} (already that)`);
          }
        }

        return {
          content: [
            {
              type: 'text',
              text: [
                moved
                  ? `Updated the group ${after.name}.`
                  : `The group ${after.name} already had those values, so nothing changed.`,
                '',
                ...rows,
              ].join('\n'),
            },
          ],
        };
      } catch (error) {
        const message = describeError(error);
        return { content: [{ type: 'text', text: `Error: ${message}` }], isError: true };
      }
    },
  );
}
