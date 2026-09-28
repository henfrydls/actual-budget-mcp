import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import * as api from '@actual-app/api';
import { ensureConnection } from '../../connection.js';
import { formatMoney } from '../../utils/money.js';
import { resolveMonth } from '../../utils/dates.js';
import { sectionHeader, formatTable } from '../../utils/formatters.js';
import type { BudgetMonth, BudgetMonthGroup } from '../../types.js';
import { describeError } from '../../utils/errors.js';
import { isIncome } from '../../utils/income.js';

export function registerBudgetVsActual(server: McpServer): void {
  server.tool(
    'budget_vs_actual',
    'Compare budgeted amounts versus actual spending for each category in a given month. Highlights over-budget and under-budget categories.',
    {
      month: z
        .string()
        .optional()
        .describe('Month (YYYY-MM or natural language). Defaults to current month.'),
      group: z
        .string()
        .optional()
        .describe('Filter to a specific category group name'),
    },
    { title: 'Budget vs actual spending', readOnlyHint: true },
    async ({ month: monthInput, group: groupFilter }) => {
      try {
        await ensureConnection();
        const month = resolveMonth(monthInput);
        const budget = (await api.getBudgetMonth(month)) as unknown as BudgetMonth;

        const lines: string[] = [sectionHeader(`Budget vs Actual: ${month}`), ''];

        let overCount = 0;
        let underCount = 0;
        let totalOverspend = 0;
        let totalUnderspend = 0;

        for (const grp of budget.categoryGroups as BudgetMonthGroup[]) {
          if (grp.is_income) continue;
          if (!grp.categories || grp.categories.length === 0) continue;

          if (groupFilter) {
            const lower = groupFilter.toLowerCase();
            if (!grp.name.toLowerCase().includes(lower)) continue;
          }

          lines.push(grp.name);

          const headers = ['Category', 'Budgeted', 'Actual', 'Variance', 'Status'];
          const rows: string[][] = [];

          for (const cat of grp.categories) {
            // The category's own flag; see #116.
            if (isIncome(grp, cat)) continue;
            const variance = cat.budgeted + cat.spent; // spent is negative
            let status: string;

            // A category whose net for the month is positive did not spend
            // anything: money came in, through a refund, a reimbursement, or a
            // transfer booked against it. Calling that "Under Budget" by the
            // whole amount is wrong twice over (#131). Measured: a category
            // that received 20,113.00 was listed as under budget by 20,113.00
            // **and counted into the footer**, which then read "Under budget:
            // 2 categories (total: 20,613.00)" — a figure that was almost
            // entirely one reimbursement, and the figure anyone would quote.
            //
            // So it is left out of both the status and the totals. Excluding
            // it from the list while leaving it in the sum would look correct
            // and still mislead.
            if (cat.spent > 0) {
              status = 'money came in';
            } else if (cat.budgeted === 0 && cat.spent === 0) {
              status = '--';
            } else if (variance < 0) {
              status = 'OVER BUDGET';
              overCount++;
              totalOverspend += variance;
            } else if (variance === 0) {
              status = 'On Target';
            } else {
              status = 'Under Budget';
              underCount++;
              totalUnderspend += variance;
            }

            rows.push([
              `  ${cat.name}`,
              formatMoney(cat.budgeted),
              formatMoney(cat.spent),
              formatMoney(variance),
              status,
            ]);
          }

          lines.push(
            formatTable(headers, rows, ['left', 'right', 'right', 'right', 'left']),
          );
          lines.push('');
        }

        lines.push(`Over budget: ${overCount} categories (total: ${formatMoney(totalOverspend)})`);
        lines.push(`Under budget: ${underCount} categories (total: ${formatMoney(totalUnderspend)})`);

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
