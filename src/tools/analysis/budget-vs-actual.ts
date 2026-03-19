import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import * as api from '@actual-app/api';
import { ensureConnection } from '../../connection.js';
import { formatMoney } from '../../utils/money.js';
import { resolveMonth } from '../../utils/dates.js';
import { sectionHeader, formatTable } from '../../utils/formatters.js';
import type { BudgetMonth, BudgetMonthGroup } from '../../types.js';

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
            const variance = cat.budgeted + cat.spent; // spent is negative
            let status: string;

            if (cat.budgeted === 0 && cat.spent === 0) {
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
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: 'text', text: `Error: ${message}` }],
          isError: true,
        };
      }
    },
  );
}
