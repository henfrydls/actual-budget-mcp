import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import * as api from '@actual-app/api';
import { ensureConnection } from '../../connection.js';
import { resolveCategoryId, resolveCategoryGroupId } from '../../utils/resolvers.js';
import { describeError } from '../../utils/errors.js';
import { requireConfirmation } from '../../utils/confirm.js';

export interface DeleteCategoryGroupInput {
  group: string;
  transfer_to: string;
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
  const transferId = await resolveCategoryId(input.transfer_to);

  const groups = await api.getCategoryGroups();
  const grp = groups.find((g) => g.id === groupId);
  const groupName = grp?.name || input.group;

  const categories = await api.getCategories();
  const transferCat = categories.find((c) => c.id === transferId);
  const inGroup = categories.filter((c) => 'group_id' in c && c.group_id === groupId);

  const confirmation = requireConfirmation({
    subject: `Category group: ${groupName}`,
    losses: [
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
  await api.sync();

  return {
    deleted: true,
    lines: [
      `Category group "${groupName}" deleted.`,
      `Transactions transferred to: ${transferCat?.name || input.transfer_to}`,
    ],
  };
}

export function registerDeleteCategoryGroup(server: McpServer): void {
  server.tool(
    'delete_category_group',
    'Delete a category group and every category in it. Destructive and irreversible: the ' +
      'first call only previews, and deleting requires confirm: true plus confirm_name set ' +
      "to the group's exact name. You must specify a category to transfer orphaned " +
      "categories' transactions to.",
    {
      group: z.string().describe('Category group name or ID to delete'),
      transfer_to: z.string().describe('Category name or ID to transfer orphaned transactions to'),
      confirm: z
        .boolean()
        .optional()
        .describe('Must be true to delete. Without it, the tool only previews.'),
      confirm_name: z
        .string()
        .optional()
        .describe("The group's exact name, echoed back as a safeguard."),
    },
    { readOnlyHint: false, destructiveHint: true },
    async (input) => {
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
  );
}
