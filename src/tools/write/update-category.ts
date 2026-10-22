import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import * as api from '@actual-app/api';
import { ensureConnection } from '../../connection.js';
import { resolveCategoryId } from '../../utils/resolvers.js';
import { describeError } from '../../utils/errors.js';
import { syncNow } from '../../utils/sync-clock.js';

/**
 * A category as `getCategories` hands it over.
 *
 * The published type has `name` and `id` and stops there, while the rows
 * carry `hidden` and `group_id` too, which is what the reply is made of.
 */
interface CategoryRow {
  id: string;
  name: string;
  hidden?: boolean;
  group_id?: string;
}

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
        //
        // And when one name is in two groups, which Actual allows, what is
        // being asked says which one is meant: unhiding means the hidden one,
        // hiding or renaming means the one that is in the way.
        const categoryId = await resolveCategoryId(category, {
          includeHidden: true,
          prefer: hidden === false ? 'hidden' : 'visible',
        });

        const categories = await api.getCategories();
        const before = categories.find((c) => c.id === categoryId) as CategoryRow | undefined;

        const updates: Record<string, unknown> = {};
        if (name !== undefined) updates.name = name;
        if (hidden !== undefined) updates.hidden = hidden;

        if (Object.keys(updates).length === 0) {
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
          if (before?.name === undefined) {
            throw new Error(
              `Could not read the current name of "${category}", and Actual needs a name ` +
                `on every category update. Nothing was changed.`,
            );
          }
          updates.name = before.name;
        }

        await api.updateCategory(categoryId, updates as any);
        await syncNow();

        // Read back rather than echo the request (#237). Two reasons, both
        // measured: Actual stores the name trimmed, so a rename to "  Food  "
        // answered with the argument would quote a name the budget does not
        // have; and `updateCategory` reports nothing at all, so the only way
        // to say a category changed without guessing is to look at it.
        const after = ((await api.getCategories()) as CategoryRow[]).find(
          (c) => c.id === categoryId,
        );
        if (!after) {
          throw new Error(
            `"${category}" was updated but is no longer in the budget, which should not ` +
              `happen. Check it in Actual before doing anything else.`,
          );
        }

        const groups = await api.getCategoryGroups();
        const groupName = groups.find((g) => g.id === after.group_id)?.name;
        // A category with no group left to name is not worth a second line of
        // explanation: what the caller needs is which category this was.
        const where = groupName ? `${after.name} in ${groupName}` : after.name;

        const rows: string[] = [];
        let changed = false;
        const row = (label: string, text: string) => rows.push(`  ${label.padEnd(6)} ${text}`);

        if (name !== undefined) {
          if (before?.name !== after.name) {
            changed = true;
            row('Name', `${before?.name ?? '(unknown)'} -> ${after.name}`);
          } else {
            row('Name', `${after.name} (already that)`);
          }
        }
        if (hidden !== undefined) {
          const was = Boolean(before?.hidden);
          const now = Boolean(after.hidden);
          if (was !== now) {
            changed = true;
            row('Hidden', `${was} -> ${now}`);
          } else {
            row('Hidden', `${now} (already that)`);
          }
        }

        // What was asked for against what is there now. The engine accepts a
        // rename and a hide without a word either way, so a write that did
        // not land would otherwise be reported as done.
        const wantedName = name === undefined || after.name === name.trim();
        const wantedHidden = hidden === undefined || Boolean(after.hidden) === hidden;
        if (!wantedName || !wantedHidden) {
          return {
            content: [
              {
                type: 'text',
                text: [
                  `Actual accepted the change to ${where} but it is not what is there now.`,
                  'Reporting the category as the budget holds it:',
                  '',
                  `  Name   ${after.name}`,
                  `  Hidden ${Boolean(after.hidden)}`,
                  '',
                  'Check this category in Actual before doing anything else.',
                ].join('\n'),
              },
            ],
            isError: true,
          };
        }

        return {
          content: [
            {
              type: 'text',
              text: [
                changed
                  ? `Updated ${where}.`
                  : `${where} already had those values, so nothing changed.`,
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
