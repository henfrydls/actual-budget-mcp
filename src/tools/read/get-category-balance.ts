import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import * as api from '@actual-app/api';
import { ensureConnection } from '../../connection.js';
import { formatMoney } from '../../utils/money.js';
import { resolveMonth, getMonthRange } from '../../utils/dates.js';
import { resolveCategoryId } from '../../utils/resolvers.js';
import { sectionHeader, formatTable } from '../../utils/formatters.js';
import type { BudgetMonth, BudgetMonthGroup, BudgetMonthCategory } from '../../types.js';
import { describeError } from '../../utils/errors.js';
import { budgetMonthOrMissing } from '../../utils/budget-month.js';

export function registerGetCategoryBalance(server: McpServer): void {
  server.tool(
    'get_category_balance',
    'Get the balance and spending history for a specific category across a window of months, ending in the month you name or this month.',
    {
      category: z.string().describe('Category name or ID'),
      months: z
        .number()
        .optional()
        .default(3)
        .describe(
          'How many months the window covers. Defaults to 3, which is a default and not a limit: ask for 24 or 36 if that is what you want.',
        ),
      month: z
        .string()
        .optional()
        .describe(
          'The month the window ends in (YYYY-MM or natural language). Defaults to this month. Use it to look at a past period: month "2026-06" with months 3 reads April, May and June.',
        ),
    },
    { title: 'Category balance', readOnlyHint: true },
    async ({ category, months: monthCount, month: monthInput }) => {
      try {
        await ensureConnection();
        if (!Number.isInteger(monthCount) || monthCount < 1) {
          throw new Error(
            `months must be a whole number of at least 1. Got ${monthCount}. There is no upper limit.`,
          );
        }
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

        // Anchored the same way as `category_trends`. This tool is named in
        // #90 as part of the same sweep, the need is identical, and one of the
        // two taking an anchor while the other silently ignores it is the
        // shape that cost the time in the first place.
        const monthRange = getMonthRange(resolveMonth(monthInput), monthCount);

        const lines: string[] = [
          sectionHeader(`Category: ${catName}${groupName ? ` (${groupName})` : ''}`),
          '',
        ];

        const headers = ['Month', 'Budgeted', 'Spent', 'Balance'];
        const rows: string[][] = [];
        let totalSpent = 0;
        let monthsWithData = 0;

        for (const month of monthRange) {
          // Before the budget file starts this throws rather than coming back
          // empty, which killed any window long enough to reach it (#90).
          const budget = await budgetMonthOrMissing(month);
          if (!budget) continue;
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
        const message = describeError(error);
        return {
          content: [{ type: 'text', text: `Error: ${message}` }],
          isError: true,
        };
      }
    },
  );
}
