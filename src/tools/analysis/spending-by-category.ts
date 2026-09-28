import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import * as api from '@actual-app/api';
import { ensureConnection } from '../../connection.js';
import { formatMoney, centsToAmount } from '../../utils/money.js';
import { resolveDate } from '../../utils/dates.js';
import { sectionHeader, formatTable, formatPercent } from '../../utils/formatters.js';
import { describeError } from '../../utils/errors.js';
import { isIncome } from '../../utils/income.js';

export function registerSpendingByCategory(server: McpServer): void {
  server.tool(
    'spending_by_category',
    'Break down spending by category for a date range. Shows each category\'s total spending and percentage of total.',
    {
      start_date: z
        .string()
        .optional()
        .describe('Start date (YYYY-MM-DD or natural language). Defaults to start of current month.'),
      end_date: z
        .string()
        .optional()
        .describe('End date (YYYY-MM-DD or natural language). Defaults to today.'),
      include_income: z
        .boolean()
        .optional()
        .default(false)
        .describe('Include income categories (default: false)'),
      limit: z
        .number()
        .optional()
        .default(20)
        .describe('Maximum number of categories to show (default 20)'),
    },
    { title: 'Spending by category', readOnlyHint: true },
    async ({ start_date, end_date, include_income, limit }) => {
      try {
        await ensureConnection();

        const startDate = resolveDate(start_date || 'start of month');
        const endDate = resolveDate(end_date);

        // Get all accounts and their transactions
        const accounts = await api.getAccounts();
        const categories = await api.getCategories();
        const categoryMap = new Map(
          categories.filter((c) => 'group_id' in c).map((c) => [c.id, c]),
        );
        const groups = await api.getCategoryGroups();
        const groupMap = new Map(groups.map((g) => [g.id, g]));

        // Collect spending by category
        const spending = new Map<string, number>();

        for (const acct of accounts) {
          if (acct.closed) continue;
          const txns = await api.getTransactions(acct.id, startDate, endDate);
          for (const t of txns) {
            if (!t.category) continue;
            const cat = categoryMap.get(t.category);
            if (!cat || !('group_id' in cat)) continue;
            const group = groupMap.get((cat as any).group_id);
            // The category's own flag, not only the group's. This is the site
            // in #116 whose output made it visible: a salary listed as
            // spending, `include_income: false` not excluding it, and a share
            // column reading 104.2% of a total it was inflating.
            if (!include_income && isIncome(group, cat)) continue;

            const current = spending.get(t.category) || 0;
            spending.set(t.category, current + t.amount);
          }
        }

        // Sort by absolute spending (most spent first)
        const sorted = [...spending.entries()]
          .filter(([_, amount]) => amount !== 0)
          .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))
          .slice(0, limit);

        if (sorted.length === 0) {
          return {
            content: [
              {
                type: 'text',
                text: `No spending found between ${startDate} and ${endDate}.`,
              },
            ],
          };
        }

        // The share is a share **of spending**, so only the rows that are
        // spending go into its denominator.
        //
        // It used to divide each row by the algebraic total of every row, so a
        // category whose net for the period was positive — a refund, a
        // reimbursement landing in a spending category, a transfer booked
        // there — shrank the denominator and inflated everything else. Measured
        // on the figures in #128: -100.00, -50.00 and +30.00 came out as 83.3%,
        // 41.7% and 25.0%, adding up to 150%, with the row that brought money
        // in carrying a quarter of "spending". On a real budget one such
        // category produced shares summing to 135.8% over eight rows.
        //
        // The other way out was to divide by the sum of absolute values. It
        // makes the column add to 100% and keeps the part that is wrong: the
        // refund still carries a share of spending, 16.7% of it. It also
        // separates the denominator from the printed total, so 55.6% of
        // -120.00 is -66.72 rather than -100.00 and nobody can check the
        // arithmetic by hand.
        //
        // Rows that brought money in are still shown, because a reimbursement
        // in a spending category is worth noticing and dropping it is how it
        // goes unnoticed. They carry no share, and the footer separates the
        // three figures.
        const spendingRows = sorted.filter(([, amount]) => amount < 0);
        const moneyInRows = sorted.filter(([, amount]) => amount > 0);
        const totalSpending = spendingRows.reduce((sum, [, amount]) => sum + amount, 0);
        const totalMoneyIn = moneyInRows.reduce((sum, [, amount]) => sum + amount, 0);

        const lines: string[] = [
          sectionHeader(`Spending by Category: ${startDate} to ${endDate}`),
          '',
        ];

        const headers = ['Category', 'Group', 'Amount', '% of spending'];
        const rows = sorted.map(([catId, amount]) => {
          const cat = categoryMap.get(catId);
          const group = cat && 'group_id' in cat ? groupMap.get((cat as any).group_id) : undefined;
          const share =
            amount < 0 && totalSpending !== 0
              ? formatPercent((Math.abs(amount) / Math.abs(totalSpending)) * 100)
              : 'money in, not spending';
          return [cat?.name || catId, group?.name || '', formatMoney(amount), share];
        });

        lines.push(formatTable(headers, rows, ['left', 'left', 'right', 'right']));
        lines.push('');
        if (moneyInRows.length > 0) {
          // Three figures rather than one, because with money coming in they
          // are three different questions and a single "Total" answered none
          // of them clearly.
          lines.push(`Spending: ${formatMoney(totalSpending)}`);
          lines.push(`Money in: ${formatMoney(totalMoneyIn)}`);
          lines.push(`Net:      ${formatMoney(totalSpending + totalMoneyIn)}`);
        } else {
          lines.push(`Total: ${formatMoney(totalSpending)}`);
        }
        lines.push(`Categories shown: ${sorted.length}`);

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
