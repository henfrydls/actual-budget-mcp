import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import * as api from '@actual-app/api';
import { ensureConnection } from '../../connection.js';
import { formatMoney, centsToAmount } from '../../utils/money.js';
import { resolveDate } from '../../utils/dates.js';
import { sectionHeader, formatTable, formatPercent } from '../../utils/formatters.js';

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
            if (!include_income && group?.is_income) continue;

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

        const totalSpending = sorted.reduce((sum, [_, amount]) => sum + amount, 0);

        const lines: string[] = [
          sectionHeader(`Spending by Category: ${startDate} to ${endDate}`),
          '',
        ];

        const headers = ['Category', 'Group', 'Amount', '% of Total'];
        const rows = sorted.map(([catId, amount]) => {
          const cat = categoryMap.get(catId);
          const group = cat && 'group_id' in cat ? groupMap.get((cat as any).group_id) : undefined;
          const pct = totalSpending !== 0 ? (Math.abs(amount) / Math.abs(totalSpending)) * 100 : 0;
          return [
            cat?.name || catId,
            group?.name || '',
            formatMoney(amount),
            formatPercent(pct),
          ];
        });

        lines.push(formatTable(headers, rows, ['left', 'left', 'right', 'right']));
        lines.push('');
        lines.push(`Total: ${formatMoney(totalSpending)}`);
        lines.push(`Categories shown: ${sorted.length}`);

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
