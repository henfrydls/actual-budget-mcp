import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

// Read tools
import { registerListAccounts } from './read/list-accounts.js';
import { registerGetBudgetMonth } from './read/get-budget-month.js';
import { registerGetTransactions } from './read/get-transactions.js';
import { registerGetCategoryBalance } from './read/get-category-balance.js';
import { registerGetBudgetSummary } from './read/get-budget-summary.js';
import { registerGetCategories } from './read/get-categories.js';
import { registerGetPayees } from './read/get-payees.js';

// Analysis tools
import { registerBudgetVsActual } from './analysis/budget-vs-actual.js';
import { registerSpendingProjection } from './analysis/spending-projection.js';
import { registerCategoryTrends } from './analysis/category-trends.js';
import { registerSpendingByCategory } from './analysis/spending-by-category.js';
import { registerMonthlySummary } from './analysis/monthly-summary.js';

// Read tools (continued)
import { registerBalanceHistory } from './read/balance-history.js';

// Write tools
import { registerCreateTransaction } from './write/create-transaction.js';
import { registerUpdateBudgetAmount } from './write/update-budget-amount.js';
import { registerRecategorizeTransaction } from './write/recategorize-transaction.js';
import { registerCreateTransfer } from './write/create-transfer.js';
import { registerUpdateTransaction } from './write/update-transaction.js';
import { registerDeleteTransaction } from './write/delete-transaction.js';
import { registerRunBankSync } from './write/run-bank-sync.js';
import { registerCreateCategory } from './write/create-category.js';
import { registerUpdateCategory } from './write/update-category.js';
import { registerDeleteCategory } from './write/delete-category.js';
import { registerCreateCategoryGroup } from './write/create-category-group.js';
import { registerUpdateCategoryGroup } from './write/update-category-group.js';
import { registerDeleteCategoryGroup } from './write/delete-category-group.js';
import { registerCreatePayee } from './write/create-payee.js';
import { registerUpdatePayee } from './write/update-payee.js';
import { registerDeletePayee } from './write/delete-payee.js';
import { registerGetRules } from './read/get-rules.js';
import { registerCreateRule } from './write/create-rule.js';
import { registerDeleteRule } from './write/delete-rule.js';

export function registerAllTools(server: McpServer): void {
  // Read
  registerListAccounts(server);
  registerGetBudgetMonth(server);
  registerGetTransactions(server);
  registerGetCategoryBalance(server);
  registerGetBudgetSummary(server);
  registerGetCategories(server);
  registerGetPayees(server);

  // Analysis
  registerBudgetVsActual(server);
  registerSpendingProjection(server);
  registerCategoryTrends(server);
  registerSpendingByCategory(server);
  registerMonthlySummary(server);
  registerBalanceHistory(server);

  // Write
  registerCreateTransaction(server);
  registerUpdateBudgetAmount(server);
  registerRecategorizeTransaction(server);
  registerCreateTransfer(server);
  registerUpdateTransaction(server);
  registerDeleteTransaction(server);
  registerRunBankSync(server);

  // Category CRUD
  registerCreateCategory(server);
  registerUpdateCategory(server);
  registerDeleteCategory(server);
  registerCreateCategoryGroup(server);
  registerUpdateCategoryGroup(server);
  registerDeleteCategoryGroup(server);

  // Payee CRUD
  registerCreatePayee(server);
  registerUpdatePayee(server);
  registerDeletePayee(server);

  // Rule CRUD
  registerGetRules(server);
  registerCreateRule(server);
  registerDeleteRule(server);
}
