import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import * as api from '@actual-app/api';
import { ensureConnection } from '../../connection.js';
import { formatMoney } from '../../utils/money.js';

export function registerDeleteTransaction(server: McpServer): void {
  server.tool(
    'delete_transaction',
    'Delete a transaction by its ID. This action cannot be undone.',
    {
      transaction_id: z.string().describe('Transaction ID to delete'),
    },
    async ({ transaction_id }) => {
      try {
        await ensureConnection();

        // Fetch transaction details before deleting for confirmation
        const accounts = await api.getAccounts();
        const categories = await api.getCategories();
        const categoryMap = new Map(
          categories.filter((c) => 'group_id' in c).map((c) => [c.id, c.name]),
        );
        const payees = await api.getPayees();
        const payeeMap = new Map(payees.map((p) => [p.id, p.name]));

        // Search for transaction across all accounts to show details before deleting
        let txnInfo = '';
        const today = new Date().toISOString().slice(0, 10);
        for (const acct of accounts) {
          if (acct.closed) continue;
          const txns = await api.getTransactions(acct.id, '2000-01-01', today);
          const found = txns.find((t: any) => t.id === transaction_id);
          if (found) {
            const payeeName = found.payee ? payeeMap.get(found.payee) || '' : '';
            const catName = found.category ? categoryMap.get(found.category) || '' : '';
            txnInfo = [
              `  Date:     ${found.date}`,
              `  Amount:   ${formatMoney(found.amount)}`,
              payeeName ? `  Payee:    ${payeeName}` : '',
              catName ? `  Category: ${catName}` : '',
              `  Account:  ${acct.name}`,
            ].filter(Boolean).join('\n');
            break;
          }
        }

        await api.deleteTransaction(transaction_id);
        await api.sync();

        const lines = [`Transaction ${transaction_id} deleted.`];
        if (txnInfo) {
          lines.push('Deleted transaction:');
          lines.push(txnInfo);
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
