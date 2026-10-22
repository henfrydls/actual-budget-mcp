import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import * as api from '@actual-app/api';
import { ensureConnection } from '../../connection.js';
import { sectionHeader } from '../../utils/formatters.js';
import { describeError } from '../../utils/errors.js';
import { isIncome } from '../../utils/income.js';

/** A category row with the fields this reply is made of. */
interface CategoryRow {
  id: string;
  name: string;
  hidden?: boolean;
  group_id?: string;
}

/** A group row, which carries a `hidden` flag of its own. */
interface GroupRow {
  id: string;
  name: string;
  is_income?: boolean;
  hidden?: boolean;
}

/**
 * Listing the categories, and saying what is not in the list (#238).
 *
 * Hidden categories were left out with nothing to say they existed. Seen in
 * the live test of 0.10.9: one hidden category showed in `get_budget_month`
 * and not here, so the way to find it in order to unhide it was to know it
 * was there already.
 *
 * They stay out by default, which keeps the ordinary reply the length of the
 * budget rather than the length of its history, and the reply ends with how
 * many were left out and how to ask for them.
 *
 * ## A hidden group is the other half
 *
 * Measured: hiding a group leaves every category in it with `hidden: false`,
 * so this listed them as ordinary categories while the app showed none of
 * them. They are treated as hidden here too, counted apart because what
 * brings them back is `update_category_group` rather than `update_category`.
 */
export function registerGetCategories(server: McpServer): void {
  server.tool(
    'get_categories',
    'List all category groups with their categories and IDs. Useful for seeing the full budget structure.',
    {
      include_hidden: z
        .boolean()
        .optional()
        .describe(
          'List hidden categories too, and the ones whose group is hidden, each marked. ' +
            'Off by default.',
        ),
    },
    { title: 'List categories', readOnlyHint: true },
    async ({ include_hidden: includeHidden }) => {
      try {
        await ensureConnection();
        const groups = (await api.getCategoryGroups()) as unknown as GroupRow[];
        const categories = (await api.getCategories()) as unknown as CategoryRow[];

        const groupById = new Map(groups.map((g) => [g.id, g]));
        const groupIsHidden = (cat: CategoryRow) =>
          Boolean(cat.group_id !== undefined && groupById.get(cat.group_id)?.hidden);

        // Counted while walking the categories rather than from the lines, so
        // a category left out by one of the filters below cannot go unsaid.
        let hiddenOwn = 0;
        let hiddenByGroup = 0;
        for (const cat of categories) {
          if (cat.hidden) hiddenOwn += 1;
          else if (groupIsHidden(cat)) hiddenByGroup += 1;
        }

        /** Shown, or kept for the closing line. */
        const listed = (cat: CategoryRow) =>
          includeHidden === true || (!cat.hidden && !groupIsHidden(cat));

        /** What a line says about a category that is not an ordinary one. */
        const mark = (cat: CategoryRow) => {
          if (cat.hidden) return '  [hidden]';
          if (groupIsHidden(cat)) return '  [in a hidden group]';
          return '';
        };

        const lines: string[] = [sectionHeader('Categories'), ''];

        for (const group of groups) {
          if (group.is_income) continue;

          const groupCats = categories.filter(
            (c) =>
              c.group_id === group.id &&
              listed(c) &&
              // Its own flag, not the group's: an income category dragged in
              // here keeps it, and listing it as spending is what #116 is.
              !isIncome(undefined, c as never),
          );

          if (groupCats.length === 0) continue;

          lines.push(`${group.name} (${group.id})${group.hidden ? '  [hidden]' : ''}`);

          for (const cat of groupCats) {
            lines.push(`  ${cat.name} (${cat.id})${mark(cat)}`);
          }

          lines.push('');
        }

        // Income. Everything flagged income, wherever its group sits, so a
        // category moved into a spending group is still listed as what it is
        // rather than disappearing from the reply altogether.
        const incomeGroup = groups.find((g) => g.is_income);
        const incomeCats = categories.filter(
          (c) => listed(c) && isIncome(groupById.get(c.group_id ?? '') as never, c as never),
        );
        if (incomeCats.length > 0) {
          lines.push(`${incomeGroup?.name ?? 'Income'} (${incomeGroup?.id ?? ''})`);
          for (const cat of incomeCats) {
            const home = groupById.get(cat.group_id ?? '');
            // Said out loud, because otherwise the reply shows a category
            // under a group it is not actually in.
            const where = home && home.id !== incomeGroup?.id ? `  [in ${home.name}]` : '';
            lines.push(`  ${cat.name} (${cat.id})${where}${mark(cat)}`);
          }
          lines.push('');
        }

        const left = notListed(includeHidden === true, hiddenOwn, hiddenByGroup);
        if (left !== undefined) lines.push(left);

        return { content: [{ type: 'text', text: lines.join('\n') }] };
      } catch (error) {
        const message = describeError(error);
        return {
          content: [{ type: 'text', text: `Error: ${message}` }],
          isError: true,
        };
      }
    },
  );
}

/**
 * The closing line, when there is something the reply does not show.
 *
 * The two counts are kept apart because they are undone by different tools:
 * a hidden category comes back with `update_category`, and a category in a
 * hidden group comes back with `update_category_group`, which is not
 * something the reply can expect anyone to work out.
 */
function notListed(includeHidden: boolean, own: number, byGroup: number): string | undefined {
  if (includeHidden || own + byGroup === 0) return undefined;

  const parts: string[] = [];
  if (own > 0) parts.push(`${own} hidden ${own === 1 ? 'category' : 'categories'}`);
  if (byGroup > 0) {
    parts.push(
      `${byGroup} ${byGroup === 1 ? 'category' : 'categories'} in a hidden group`,
    );
  }

  return `Not listed: ${parts.join(', and ')}. Pass include_hidden: true to see them.`;
}
