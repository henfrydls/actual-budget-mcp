import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import * as api from '@actual-app/api';
import { ensureConnection } from '../../connection.js';
import { formatMoney } from '../../utils/money.js';
import { resolveMonth, daysInMonth, daysElapsed } from '../../utils/dates.js';
import { sectionHeader, formatTable, formatPercent } from '../../utils/formatters.js';
import type { BudgetMonth, BudgetMonthGroup } from '../../types.js';

export function registerSpendingProjection(server: McpServer): void {
  server.tool(
    'spending_projection',
    'Project end-of-month spending for each category based on the current daily spending rate. Warns about categories likely to exceed budget.',
    {
      month: z
        .string()
        .optional()
        .describe('Month to project (YYYY-MM or natural language). Defaults to current month.'),
    },
    { readOnlyHint: true },
    async ({ month: monthInput }) => {
      try {
        await ensureConnection();
        const month = resolveMonth(monthInput);
        const budget = (await api.getBudgetMonth(month)) as unknown as BudgetMonth;

        const totalDays = daysInMonth(month);
        const elapsed = daysElapsed(month);
        const pctElapsed = elapsed > 0 ? (elapsed / totalDays) * 100 : 0;

        const lines: string[] = [
          sectionHeader(`Spending Projection: ${month}`),
          `(Based on ${elapsed} of ${totalDays} days elapsed - ${formatPercent(pctElapsed)})`,
          '',
        ];

        if (elapsed === 0) {
          lines.push('No days elapsed yet — projection not available.');
          return { content: [{ type: 'text', text: lines.join('\n') }] };
        }

        const headers = ['Category', 'Budgeted', 'Spent So Far', 'Projected', 'Status'];
        const rows: string[][] = [];
        let atRiskCount = 0;
        let projectedOverspend = 0;

        for (const grp of budget.categoryGroups as BudgetMonthGroup[]) {
          if (grp.is_income) continue;
          if (!grp.categories || grp.categories.length === 0) continue;

          for (const cat of grp.categories) {
            if (cat.budgeted === 0 && cat.spent === 0) continue;

            const spent = Math.abs(cat.spent);
            let projected: number;
            let status: string;

            // If spent >= budgeted, likely a single payment (rent, etc.)
            if (spent >= Math.abs(cat.budgeted) && cat.budgeted !== 0) {
              projected = spent;
              status = 'Paid';
            } else if (elapsed >= totalDays) {
              projected = spent;
              status = spent > Math.abs(cat.budgeted) ? 'OVER' : 'OK';
            } else {
              const dailyRate = spent / elapsed;
              projected = Math.round(dailyRate * totalDays);

              if (cat.budgeted === 0) {
                status = spent > 0 ? 'Unbudgeted' : '--';
              } else if (projected > Math.abs(cat.budgeted)) {
                status = 'AT RISK';
                atRiskCount++;
                projectedOverspend += projected - Math.abs(cat.budgeted);
              } else {
                status = 'On Track';
              }
            }

            rows.push([
              cat.name,
              formatMoney(cat.budgeted),
              formatMoney(cat.spent),
              formatMoney(-projected), // negative to match spent convention
              status,
            ]);
          }
        }

        lines.push(
          formatTable(headers, rows, ['left', 'right', 'right', 'right', 'left']),
        );
        lines.push('');
        lines.push(`Categories at risk of exceeding budget: ${atRiskCount}`);
        if (projectedOverspend > 0) {
          lines.push(`Projected overspend: ${formatMoney(-projectedOverspend)}`);
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
