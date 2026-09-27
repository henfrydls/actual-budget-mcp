import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as api from '@actual-app/api';
import { ensureConnection } from '../../connection.js';
import { sectionHeader } from '../../utils/formatters.js';
import { describeError } from '../../utils/errors.js';
import { isIncome } from '../../utils/income.js';

export function registerGetCategories(server: McpServer): void {
  server.tool(
    'get_categories',
    'List all category groups with their categories and IDs. Useful for seeing the full budget structure.',
    {},
    { title: 'List categories', readOnlyHint: true },
    async () => {
      try {
        await ensureConnection();
        const groups = await api.getCategoryGroups();
        const categories = await api.getCategories();

        const lines: string[] = [sectionHeader('Categories'), ''];

        for (const group of groups) {
          if (group.is_income) continue;

          const groupCats = categories.filter(
            (c) =>
              'group_id' in c &&
              (c as any).group_id === group.id &&
              !c.hidden &&
              // Its own flag, not the group's: an income category dragged in
              // here keeps it, and listing it as spending is what #116 is.
              !isIncome(undefined, c),
          );

          if (groupCats.length === 0) continue;

          lines.push(`${group.name} (${group.id})`);

          for (const cat of groupCats) {
            lines.push(`  ${cat.name} (${cat.id})`);
          }

          lines.push('');
        }

        // Income. Everything flagged income, wherever its group sits, so a
        // category moved into a spending group is still listed as what it is
        // rather than disappearing from the reply altogether.
        const incomeGroup = groups.find((g) => g.is_income);
        const groupById = new Map(groups.map((g) => [g.id, g]));
        const incomeCats = categories.filter(
          (c) =>
            'group_id' in c &&
            !c.hidden &&
            isIncome(groupById.get((c as any).group_id), c),
        );
        if (incomeCats.length > 0) {
          lines.push(`${incomeGroup?.name ?? 'Income'} (${incomeGroup?.id ?? ''})`);
          for (const cat of incomeCats) {
            const home = groupById.get((cat as any).group_id);
            // Said out loud, because otherwise the reply shows a category
            // under a group it is not actually in.
            const where = home && home.id !== incomeGroup?.id ? `  [in ${home.name}]` : '';
            lines.push(`  ${cat.name} (${cat.id})${where}`);
          }
          lines.push('');
        }

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
