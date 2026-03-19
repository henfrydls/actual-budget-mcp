import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import * as api from '@actual-app/api';
import { ensureConnection } from '../../connection.js';
import { formatMoney } from '../../utils/money.js';
import { resolveMonth, getMonthRange } from '../../utils/dates.js';
import { resolveCategoryId } from '../../utils/resolvers.js';
import { sectionHeader, formatTable } from '../../utils/formatters.js';
import type { BudgetMonth, BudgetMonthGroup, BudgetMonthCategory } from '../../types.js';

export function registerGetCategoryBalance(server: McpServer): void {
  server.tool(
    'get_category_balance',
    'Get the balance and spending history for a specific category across one or more months.',
    {
      category: z.string().describe('Category name or ID'),
      months: z
        .number()
        .optional()
        .default(3)
        .describe('Number of months to look back (default 3)'),
    },
    async ({ category, months: monthCount }) => {
      try {
        await ensureConnection();
        const categoryId = await resolveCategoryId(category);

        // Get category name and group
        const categories = await api.getCategories();
        const catEntity = categories.find((c) => c.id === categoryId);
        const catName = catEntity?.name || category;

        const groups = await api.getCategoryGroups();
        let groupName = '';
        if (catEntity && 'group_id' in catEntity) {
          const group = groups.find((g) => g.id === catEntity.group_id);
          groupName = group?.name || '';
        }

        const currentMonth = resolveMonth();
        const monthRange = getMonthRange(currentMonth, monthCount);

        const lines: string[] = [
          sectionHeader(`Category: ${catName}${groupName ? ` (${groupName})` : ''}`),
          '',
        ];

        const headers = ['Month', 'Budgeted', 'Spent', 'Balance'];
        const rows: string[][] = [];
        let totalSpent = 0;
        let monthsWithData = 0;

        for (const month of monthRange) {
          const budget = (await api.getBudgetMonth(month)) as unknown as BudgetMonth;
          let found: BudgetMonthCategory | undefined;

          for (const group of budget.categoryGroups as BudgetMonthGroup[]) {
            if (!group.categories) continue;
            found = group.categories.find((c) => c.id === categoryId);
            if (found) break;
          }

          if (found) {
            rows.push([
              month,
              formatMoney(found.budgeted),
              formatMoney(found.spent),
              formatMoney(found.balance),
            ]);
            totalSpent += found.spent;
            monthsWithData++;
          } else {
            rows.push([month, '0.00', '0.00', '0.00']);
          }
        }

        lines.push(formatTable(headers, rows, ['left', 'right', 'right', 'right']));

        if (monthsWithData > 0) {
          lines.push('');
          lines.push(
            `${monthCount}-month avg spent: ${formatMoney(Math.round(totalSpent / monthsWithData))}`,
          );
        }

        return { content: [{ type: 'text', text: lines.join('\n') }] };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: 'text', text: `Error: ${message}` }],
          isError: true,
        };
      }
    },
  );
}
