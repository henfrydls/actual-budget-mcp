import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import * as api from '@actual-app/api';
import { ensureConnection } from '../../connection.js';
import { formatMoney, centsToAmount } from '../../utils/money.js';
import { resolveMonth, getMonthRange } from '../../utils/dates.js';
import { sectionHeader, formatTable, formatPercent } from '../../utils/formatters.js';
import type { BudgetMonth, BudgetMonthGroup } from '../../types.js';

export function registerMonthlySummary(server: McpServer): void {
  server.tool(
    'monthly_summary',
    'Monthly financial summary showing income, expenses, savings, and savings rate across multiple months. Great for seeing trends in your overall financial health.',
    {
      months: z
        .number()
        .optional()
        .default(3)
        .describe('Number of months to show (default 3)'),
    },
    async ({ months: monthCount }) => {
      try {
        await ensureConnection();
        const currentMonth = resolveMonth();
        const monthRange = getMonthRange(currentMonth, monthCount);

        const lines: string[] = [
          sectionHeader(`Monthly Summary (${monthCount} months)`),
          '',
        ];

        const headers = ['Month', 'Income', 'Expenses', 'Savings', 'Rate'];
        const rows: string[][] = [];
        let totalIncome = 0;
        let totalExpenses = 0;

        for (const month of monthRange) {
          const budget = (await api.getBudgetMonth(month)) as unknown as BudgetMonth;
          const income = budget.totalIncome;
          const spent = budget.totalSpent; // negative
          const savings = income + spent;
          const rate = income !== 0 ? (savings / Math.abs(income)) * 100 : 0;

          totalIncome += income;
          totalExpenses += spent;

          rows.push([
            month,
            formatMoney(income),
            formatMoney(spent),
            formatMoney(savings),
            formatPercent(rate),
          ]);
        }

        lines.push(formatTable(headers, rows, ['left', 'right', 'right', 'right', 'right']));

        const totalSavings = totalIncome + totalExpenses;
        const avgRate = totalIncome !== 0 ? (totalSavings / Math.abs(totalIncome)) * 100 : 0;

        lines.push('');
        lines.push(`Average Income:   ${formatMoney(Math.round(totalIncome / monthCount))}`);
        lines.push(`Average Expenses: ${formatMoney(Math.round(totalExpenses / monthCount))}`);
        lines.push(`Average Savings:  ${formatMoney(Math.round(totalSavings / monthCount))}`);
        lines.push(`Overall Rate:     ${formatPercent(avgRate)}`);

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
