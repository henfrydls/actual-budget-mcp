import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import * as api from '@actual-app/api';
import { ensureConnection } from '../../connection.js';
import { formatMoney, centsToAmount } from '../../utils/money.js';
import { resolveMonth } from '../../utils/dates.js';
import { sectionHeader, formatPercent } from '../../utils/formatters.js';
import type { BudgetMonth, BudgetMonthGroup } from '../../types.js';
import { describeError } from '../../utils/errors.js';
import { isIncome, totalsWithMisfiledIncome } from '../../utils/income.js';

export function registerGetBudgetSummary(server: McpServer): void {
  server.tool(
    'get_budget_summary',
    'Executive summary of the budget showing totals by category group, total income, total expenses, savings rate, and to-be-budgeted for a given month.',
    {
      month: z
        .string()
        .optional()
        .describe(
          'Month (YYYY-MM or natural language). Defaults to current month.',
        ),
    },
    { title: 'Budget summary', readOnlyHint: true },
    async ({ month: monthInput }) => {
      try {
        await ensureConnection();
        const month = resolveMonth(monthInput);
        const budget = (await api.getBudgetMonth(month)) as unknown as BudgetMonth;

        // The engine files an income category by its group, so a misfiled one is
        // missing from income and sitting inside spending. Measured on that
        // shape: income 0.00 with a salary of 5,000.00 in the budget, and
        // spending of 4,800.00 against real spending of 200.00.
        const { income, spent: totalSpent } = totalsWithMisfiledIncome(budget);

        const lines: string[] = [
          sectionHeader(`Budget Summary: ${month}`),
          '',
          `Income:            ${formatMoney(income).padStart(14)}`,
          `Total Budgeted:    ${formatMoney(budget.totalBudgeted).padStart(14)}`,
          `To Be Budgeted:    ${formatMoney(budget.toBudget).padStart(14)}`,
          '',
          'Group Breakdown:',
        ];

        for (const group of budget.categoryGroups as BudgetMonthGroup[]) {
          if (group.is_income) continue;
          if (!group.categories || group.categories.length === 0) continue;

          let groupBudgeted = 0;
          let groupSpent = 0;

          for (const cat of group.categories) {
            // Its own flag, not the group's. An income category dragged into a
            // spending group keeps it, and the engine still reports its figures
            // here, so without this its salary lands in the group's spending.
            if (isIncome(group, cat)) continue;
            groupBudgeted += cat.budgeted;
            groupSpent += cat.spent;
          }

          const pct =
            groupBudgeted !== 0
              ? Math.abs(centsToAmount(groupSpent) / centsToAmount(groupBudgeted)) * 100
              : 0;

          lines.push(
            `  ${group.name.padEnd(28)} ${formatMoney(groupBudgeted).padStart(12)} budgeted | ${formatMoney(groupSpent).padStart(12)} spent (${formatPercent(pct)})`,
          );
        }


        const remaining = income + totalSpent; // totalSpent is negative
        const savingsRate = income !== 0 ? (remaining / Math.abs(income)) * 100 : 0;

        lines.push('');
        lines.push(`Total Spent:       ${formatMoney(totalSpent).padStart(14)}`);
        lines.push(`Remaining:         ${formatMoney(remaining).padStart(14)}`);
        lines.push(`Savings Rate:      ${formatPercent(savingsRate).padStart(14)}`);

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
