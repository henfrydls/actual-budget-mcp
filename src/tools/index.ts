import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

// Read tools
import { registerListAccounts } from './read/list-accounts.js';
import { registerGetBudgetMonth } from './read/get-budget-month.js';
import { registerGetTransactions } from './read/get-transactions.js';
import { registerGetCategoryBalance } from './read/get-category-balance.js';
import { registerGetBudgetSummary } from './read/get-budget-summary.js';

// Analysis tools
import { registerBudgetVsActual } from './analysis/budget-vs-actual.js';
import { registerSpendingProjection } from './analysis/spending-projection.js';
import { registerCategoryTrends } from './analysis/category-trends.js';

// Write tools
import { registerCreateTransaction } from './write/create-transaction.js';
import { registerUpdateBudgetAmount } from './write/update-budget-amount.js';
import { registerRecategorizeTransaction } from './write/recategorize-transaction.js';
import { registerCreateTransfer } from './write/create-transfer.js';
import { registerUpdateTransaction } from './write/update-transaction.js';
import { registerDeleteTransaction } from './write/delete-transaction.js';
import { registerRunBankSync } from './write/run-bank-sync.js';

export function registerAllTools(server: McpServer): void {
  // Read
  registerListAccounts(server);
  registerGetBudgetMonth(server);
  registerGetTransactions(server);
  registerGetCategoryBalance(server);
  registerGetBudgetSummary(server);

  // Analysis
  registerBudgetVsActual(server);
  registerSpendingProjection(server);
  registerCategoryTrends(server);

  // Write
  registerCreateTransaction(server);
  registerUpdateBudgetAmount(server);
  registerRecategorizeTransaction(server);
  registerCreateTransfer(server);
  registerUpdateTransaction(server);
  registerDeleteTransaction(server);
  registerRunBankSync(server);
}
