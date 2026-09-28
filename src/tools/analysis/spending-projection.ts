import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import * as api from '@actual-app/api';
import { ensureConnection } from '../../connection.js';
import { formatMoney } from '../../utils/money.js';
import { resolveMonth, daysInMonth, daysElapsed } from '../../utils/dates.js';
import { sectionHeader, formatTable, formatPercent } from '../../utils/formatters.js';
import type { BudgetMonth, BudgetMonthGroup } from '../../types.js';
import { describeError } from '../../utils/errors.js';
import { isIncome } from '../../utils/income.js';

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
    { title: 'Spending projection', readOnlyHint: true },
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
          lines.push('No days elapsed yet, so there is nothing to project from.');
          return { content: [{ type: 'text', text: lines.join('\n') }] };
        }

        const headers = ['Category', 'Budgeted', 'Spent So Far', 'Projected', 'Status'];
        const rows: string[][] = [];
        let atRiskCount = 0;
        let alreadyOver = 0;
        let unbudgetedCount = 0;
        let projectedOverspend = 0;

        for (const grp of budget.categoryGroups as BudgetMonthGroup[]) {
          if (grp.is_income) continue;
          if (!grp.categories || grp.categories.length === 0) continue;

          for (const cat of grp.categories) {
            // The category's own flag; see #116.
            if (isIncome(grp, cat)) continue;
            if (cat.budgeted === 0 && cat.spent === 0) continue;

            // Money came in rather than went out, so there is nothing to
            // project. Measured (#131): a category that received 20,113.00 was
            // projected as 20,113.00 **going out** and labelled OVER, because
            // `Math.abs` took the size and the row printed `-projected`. Two
            // wrongs on one line: the direction and the verdict.
            if (cat.spent > 0) {
              rows.push([
                cat.name,
                formatMoney(cat.budgeted),
                formatMoney(cat.spent),
                '--',
                'money came in',
              ]);
              continue;
            }

            const spent = Math.abs(cat.spent);
            let projected: number;
            let status: string;

            // If spent >= budgeted, likely a single payment (rent, etc.)
            if (spent >= Math.abs(cat.budgeted) && cat.budgeted !== 0) {
              projected = spent;
              status = 'Paid';
            } else if (elapsed >= totalDays) {
              projected = spent;
              if (spent > Math.abs(cat.budgeted)) {
                status = 'OVER';
                alreadyOver++;
                if (cat.budgeted === 0) unbudgetedCount++;
                projectedOverspend += spent - Math.abs(cat.budgeted);
              } else {
                status = 'OK';
              }
            } else {
              const dailyRate = spent / elapsed;
              projected = Math.round(dailyRate * totalDays);

              if (cat.budgeted === 0) {
                status = spent > 0 ? 'Unbudgeted' : '--';
                if (spent > 0) {
                  alreadyOver++;
                  unbudgetedCount++;
                  projectedOverspend += projected;
                }
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
        // The headline counted only the categories on course to exceed a
        // budget, so a month with 24 categories overspent and nothing budgeted
        // against them announced "0 at risk" (#131). A category overspent with
        // no budget at all is the clearest case of needing attention, not an
        // exception to it: there is no budget there to protect it.
        const needsAttention = atRiskCount + alreadyOver;
        const detail: string[] = [];
        if (atRiskCount > 0) detail.push(`${atRiskCount} heading that way`);
        if (alreadyOver > 0) detail.push(`${alreadyOver} already over`);
        if (unbudgetedCount > 0) detail.push(`${unbudgetedCount} with nothing budgeted`);
        lines.push(
          `Categories over or heading over budget: ${needsAttention}` +
            (detail.length > 0 ? ` (${detail.join(', ')})` : ''),
        );
        if (projectedOverspend > 0) {
          lines.push(`Projected overspend: ${formatMoney(-projectedOverspend)}`);
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
