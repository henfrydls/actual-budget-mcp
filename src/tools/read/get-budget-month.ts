import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import * as api from '@actual-app/api';
import { ensureConnection } from '../../connection.js';
import { formatMoney } from '../../utils/money.js';
import { resolveMonth } from '../../utils/dates.js';
import { sectionHeader } from '../../utils/formatters.js';
import type { BudgetMonth, BudgetMonthGroup } from '../../types.js';

export function registerGetBudgetMonth(server: McpServer): void {
  server.tool(
    'get_budget_month',
    'Get the budget for a specific month showing all category groups, their categories with budgeted amounts, actual spending, and remaining balance. Also shows the to-be-budgeted amount.',
    {
      month: z
        .string()
        .optional()
        .describe(
          'Month in YYYY-MM format, or natural language like "this month", "last month", "January 2025". Defaults to current month.',
        ),
    },
    { readOnlyHint: true },
    async ({ month: monthInput }) => {
      try {
        await ensureConnection();
        const month = resolveMonth(monthInput);
        const budget = (await api.getBudgetMonth(month)) as unknown as BudgetMonth;

        const lines: string[] = [
          sectionHeader(`Budget: ${month}`),
          `To Be Budgeted: ${formatMoney(budget.toBudget)}`,
          `Total Income: ${formatMoney(budget.totalIncome)}`,
          `Total Budgeted: ${formatMoney(budget.totalBudgeted)}`,
          `Total Spent: ${formatMoney(budget.totalSpent)}`,
          `Total Balance: ${formatMoney(budget.totalBalance)}`,
          '',
        ];

        for (const group of budget.categoryGroups as BudgetMonthGroup[]) {
          if (group.is_income) continue;
          if (!group.categories || group.categories.length === 0) continue;

          let groupBudgeted = 0;
          let groupSpent = 0;
          let groupBalance = 0;

          lines.push(group.name);

          for (const cat of group.categories) {
            groupBudgeted += cat.budgeted;
            groupSpent += cat.spent;
            groupBalance += cat.balance;

            const budgetedStr = formatMoney(cat.budgeted).padStart(12);
            const spentStr = formatMoney(cat.spent).padStart(12);
            const balanceStr = formatMoney(cat.balance).padStart(12);

            lines.push(
              `  ${cat.name.padEnd(25)} Budgeted: ${budgetedStr}  Spent: ${spentStr}  Balance: ${balanceStr}`,
            );
          }

          lines.push(
            `  ${'Group Total'.padEnd(25)} Budgeted: ${formatMoney(groupBudgeted).padStart(12)}  Spent: ${formatMoney(groupSpent).padStart(12)}  Balance: ${formatMoney(groupBalance).padStart(12)}`,
          );
          lines.push('');
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
