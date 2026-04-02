import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import * as api from '@actual-app/api';
import { ensureConnection } from '../../connection.js';
import { formatMoney } from '../../utils/money.js';
import { resolveAccountId } from '../../utils/resolvers.js';
import { resolveDate } from '../../utils/dates.js';
import { sectionHeader, formatTable } from '../../utils/formatters.js';

export function registerBalanceHistory(server: McpServer): void {
  server.tool(
    'balance_history',
    'Track an account\'s balance changes over time by showing the running balance at key transaction dates.',
    {
      account: z.string().describe('Account name or ID'),
      start_date: z
        .string()
        .optional()
        .describe('Start date (YYYY-MM-DD or natural language). Defaults to 3 months ago.'),
      end_date: z
        .string()
        .optional()
        .describe('End date (YYYY-MM-DD or natural language). Defaults to today.'),
    },
    async ({ account, start_date, end_date }) => {
      try {
        await ensureConnection();
        const accountId = await resolveAccountId(account);

        const accounts = await api.getAccounts();
        const acct = accounts.find((a) => a.id === accountId);
        const accountName = acct?.name || account;

        const endDate = resolveDate(end_date);
        const startDate = start_date
          ? resolveDate(start_date)
          : resolveDate('90 days ago');

        const txns = await api.getTransactions(accountId, startDate, endDate);

        if (txns.length === 0) {
          return {
            content: [
              {
                type: 'text',
                text: `No transactions found for ${accountName} between ${startDate} and ${endDate}.`,
              },
            ],
          };
        }

        // Sort by date ascending for running balance
        txns.sort((a: any, b: any) => a.date.localeCompare(b.date));

        // Get balance before start date to calculate running balance
        const currentBalance = await api.getAccountBalance(accountId);
        const totalAfterEnd = txns.reduce((sum: number, t: any) => sum + t.amount, 0);

        // We need balance at start = currentBalance - all txns from start to now
        // But we only have txns in our range. Get ALL txns from end_date to now.
        const txnsAfter = await api.getTransactions(accountId, endDate, resolveDate());
        const sumAfter = txnsAfter
          .filter((t: any) => t.date > endDate)
          .reduce((sum: number, t: any) => sum + t.amount, 0);

        const balanceAtEnd = currentBalance - sumAfter;
        const balanceAtStart = balanceAtEnd - totalAfterEnd;

        // Build daily balances - aggregate by date
        const dateBalances = new Map<string, number>();
        let runningBalance = balanceAtStart;

        for (const t of txns) {
          if (!(t as any).is_child) {
            runningBalance += t.amount;
            dateBalances.set(t.date, runningBalance);
          }
        }

        const lines: string[] = [
          sectionHeader(`Balance History: ${accountName}`),
          `Period: ${startDate} to ${endDate}`,
          '',
        ];

        const headers = ['Date', 'Balance', 'Change'];
        const rows: string[][] = [];
        let prevBalance = balanceAtStart;

        rows.push([startDate, formatMoney(balanceAtStart), '--']);

        for (const [date, balance] of dateBalances) {
          const change = balance - prevBalance;
          rows.push([
            date,
            formatMoney(balance),
            change >= 0 ? `+${formatMoney(change)}` : formatMoney(change),
          ]);
          prevBalance = balance;
        }

        lines.push(formatTable(headers, rows, ['left', 'right', 'right']));

        lines.push('');
        const netChange = (prevBalance) - balanceAtStart;
        lines.push(`Net change: ${netChange >= 0 ? '+' : ''}${formatMoney(netChange)}`);

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
