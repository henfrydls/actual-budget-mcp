import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import * as api from '@actual-app/api';
import { ensureConnection } from '../../connection.js';
import { resolveCategoryId, resolveCategoryGroupId } from '../../utils/resolvers.js';
import { describeError } from '../../utils/errors.js';
import { requireConfirmation } from '../../utils/confirm.js';
import { queueTransactionWrite } from '../../utils/transaction-writes.js';
import { syncNow } from '../../utils/sync-clock.js';

export interface DeleteCategoryGroupInput {
  group: string;
  /** Where the transactions go. Not needed by a group with no categories. */
  transfer_to?: string;
  confirm?: boolean;
  confirm_name?: string;
}

/**
 * Delete a category group, behind the shared confirmation guard.
 *
 * This is the widest-reaching delete in the server: it takes every category in
 * the group with it, and each one loses its budget and rollover history. The
 * preview names them so the caller sees the real scope before agreeing.
 */
export async function deleteCategoryGroupGuarded(
  input: DeleteCategoryGroupInput,
): Promise<{ deleted: boolean; lines: string[] }> {
  await ensureConnection();
  const groupId = await resolveCategoryGroupId(input.group);

  const groups = await api.getCategoryGroups();
  const grp = groups.find((g) => g.id === groupId);
  const groupName = grp?.name || input.group;

  const categories = await api.getCategories();
  const inGroup = categories.filter((c) => 'group_id' in c && c.group_id === groupId);

  // An empty group has no transactions to move, so it needs nowhere to move
  // them to (#266). Asking for one anyway made the caller name a category
  // that had nothing to do with the deletion, and the reply then said their
  // transactions had been transferred there, which was not true of anything.
  if (inGroup.length > 0 && input.transfer_to === undefined) {
    throw new Error(
      `"${groupName}" has ${inGroup.length} ${
        inGroup.length === 1 ? 'category' : 'categories'
      } in it, so deleting it needs transfer_to: the category their transactions move to. ` +
        `Nothing was deleted.`,
    );
  }
  // Resolved whenever it is given, even for an empty group. Skipping it there
  // meant a name that is not a category was accepted in silence, and the
  // caller who misspelled it had no way to know the argument had been
  // ignored rather than used.
  const transferId =
    input.transfer_to === undefined ? undefined : await resolveCategoryId(input.transfer_to);
  const transferCat = categories.find((c) => c.id === transferId);

  const confirmation = requireConfirmation({
    subject: `Category group: ${groupName}`,
    losses:
      inGroup.length === 0
        ? ['  The group is empty: no categories, no transactions to move.']
        : [
            `  Categories destroyed: ${inGroup.length}`,
            ...inGroup.map((c) => `    - ${c.name}`),
            `  Their transactions move to: ${transferCat?.name || input.transfer_to}`,
            '',
            'Every category in the group is deleted along with its budget and',
            'rollover history, which Actual cannot restore.',
          ],
    confirmName: groupName,
    input,
  });

  if (!confirmation.confirmed) {
    return { deleted: false, lines: confirmation.lines };
  }

  await api.deleteCategoryGroup(groupId, transferId);
  await syncNow();

  return {
    deleted: true,
    lines: [
      `Category group "${groupName}" deleted.`,
      ...(transferCat === undefined
        ? ['It was empty, so nothing moved.']
        : [`Transactions transferred to: ${transferCat.name}`]),
    ],
  };
}

export function registerDeleteCategoryGroup(server: McpServer): void {
  server.tool(
    'delete_category_group',
    'Delete a category group and every category in it. Destructive and irreversible: the ' +
      'first call only previews, and deleting requires confirm: true plus confirm_name set ' +
      "to the group's exact name. A group with categories in it also needs transfer_to, the " +
      'category their transactions move to; an empty group does not.',
    {
      group: z.string().describe('Category group name or ID to delete'),
      transfer_to: z
        .string()
        .optional()
        .describe(
          'Category name or ID to transfer the transactions of the deleted categories to. ' +
            'Required unless the group is empty.',
        ),
      confirm: z
        .boolean()
        .optional()
        .describe('Must be true to delete. Without it, the tool only previews.'),
      confirm_name: z
        .string()
        .optional()
        .describe("The group's exact name, echoed back as a safeguard."),
    },
    { title: 'Delete category group', readOnlyHint: false, destructiveHint: true },
    async (input) =>
      // `deleteCategoryGroup(groupId, transferId)` moves the transactions of
      // every category in the group to another one, so it writes to the
      // transactions table (#111). Neither audit listed it; the guard over the
      // directory did.
      queueTransactionWrite(async () => {
      try {
        const { deleted, lines } = await deleteCategoryGroupGuarded(input);
        return {
          content: [{ type: 'text' as const, text: lines.join('\n') }],
          ...(deleted ? {} : { isError: true }),
        };
      } catch (error) {
        return {
          content: [{ type: 'text' as const, text: `Error: ${describeError(error)}` }],
          isError: true,
        };
      }
      },
    ),
  );
}
