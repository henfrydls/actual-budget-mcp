import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import * as api from '@actual-app/api';
import { ensureConnection } from '../../connection.js';
import { formatMoney, centsToAmount } from '../../utils/money.js';
import { resolveDate } from '../../utils/dates.js';
import { resolveAccountId } from '../../utils/resolvers.js';
import { sectionHeader, formatTable } from '../../utils/formatters.js';

export function registerGetTransactions(server: McpServer): void {
  server.tool(
    'get_transactions',
    'List transactions with optional filters. Returns date, payee, category, amount, notes, and account.',
    {
      account: z
        .string()
        .optional()
        .describe('Account name or ID to filter by'),
      start_date: z
        .string()
        .optional()
        .describe(
          'Start date (YYYY-MM-DD or natural language like "start of month", "30 days ago"). Defaults to start of current month.',
        ),
      end_date: z
        .string()
        .optional()
        .describe('End date (YYYY-MM-DD or natural language). Defaults to today.'),
      category: z
        .string()
        .optional()
        .describe('Category name to filter by (partial match)'),
      payee: z
        .string()
        .optional()
        .describe('Payee name to filter by (partial match)'),
      min_amount: z
        .number()
        .optional()
        .describe('Minimum amount in human format (e.g., -500 for expenses of at least 500)'),
      max_amount: z
        .number()
        .optional()
        .describe('Maximum amount in human format'),
      limit: z
        .number()
        .optional()
        .default(50)
        .describe('Maximum number of transactions to return (default 50)'),
    },
    async ({ account, start_date, end_date, category, payee, min_amount, max_amount, limit }) => {
      try {
        await ensureConnection();

        const startDate = resolveDate(start_date || 'start of month');
        const endDate = resolveDate(end_date);

        // Get accounts to query
        const allAccounts = await api.getAccounts();
        let accountIds: string[];

        if (account) {
          const id = await resolveAccountId(account);
          accountIds = [id];
        } else {
          accountIds = allAccounts.filter((a) => !a.closed).map((a) => a.id);
        }

        // Build maps for names
        const accountMap = new Map(allAccounts.map((a) => [a.id, a.name]));
        const categories = await api.getCategories();
        const categoryMap = new Map(
          categories.filter((c) => 'group_id' in c).map((c) => [c.id, c.name]),
        );
        const payees = await api.getPayees();
        const payeeMap = new Map(payees.map((p) => [p.id, p.name]));

        // Fetch transactions from all relevant accounts
        let allTransactions: Array<{
          id: string;
          date: string;
          payee?: string;
          category?: string;
          amount: number;
          notes?: string;
          account: string;
          cleared?: boolean;
        }> = [];

        for (const accId of accountIds) {
          const txns = await api.getTransactions(accId, startDate, endDate);
          allTransactions.push(...txns);
        }

        // Sort by date descending
        allTransactions.sort((a, b) => b.date.localeCompare(a.date));

        // Apply filters
        if (category) {
          const lower = category.toLowerCase();
          allTransactions = allTransactions.filter((t) => {
            const catName = t.category ? categoryMap.get(t.category) : '';
            return catName?.toLowerCase().includes(lower);
          });
        }

        if (payee) {
          const lower = payee.toLowerCase();
          allTransactions = allTransactions.filter((t) => {
            const payeeName = t.payee ? payeeMap.get(t.payee) : '';
            return payeeName?.toLowerCase().includes(lower);
          });
        }

        if (min_amount !== undefined) {
          const minCents = Math.round(min_amount * 100);
          allTransactions = allTransactions.filter((t) => t.amount >= minCents);
        }

        if (max_amount !== undefined) {
          const maxCents = Math.round(max_amount * 100);
          allTransactions = allTransactions.filter((t) => t.amount <= maxCents);
        }

        // Apply limit
        const limited = allTransactions.slice(0, limit);

        if (limited.length === 0) {
          return {
            content: [
              {
                type: 'text',
                text: `No transactions found for the specified filters (${startDate} to ${endDate}).`,
              },
            ],
          };
        }

        const lines: string[] = [
          sectionHeader(`Transactions: ${startDate} to ${endDate}`),
          `Showing ${limited.length} of ${allTransactions.length} transactions`,
          '',
        ];

        const headers = ['ID', 'Date', 'Payee', 'Category', 'Amount', 'Account', 'Notes'];
        const rows = limited.map((t) => [
          t.id,
          t.date,
          t.payee ? payeeMap.get(t.payee) || '' : '',
          t.category ? categoryMap.get(t.category) || '' : '',
          formatMoney(t.amount),
          accountMap.get(t.account) || '',
          t.notes || '',
        ]);

        lines.push(formatTable(headers, rows, ['left', 'left', 'left', 'left', 'right', 'left', 'left']));

        // Total
        const total = limited.reduce((sum, t) => sum + t.amount, 0);
        lines.push('');
        lines.push(`Total: ${formatMoney(total)}`);

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
