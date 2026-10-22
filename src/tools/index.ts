import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { isReadOnly } from '../utils/mode.js';
import { withInFlight } from '../utils/in-flight.js';

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
import { registerReconcileAccount } from './read/reconcile-account.js';

// Write tools
import { registerCreateTransaction } from './write/create-transaction.js';
import { registerCreateTransactions } from './write/create-transactions.js';
import { registerCreateSplitTransaction } from './write/create-split-transaction.js';
import { registerReconcileCurrencyResidual } from './write/reconcile-currency-residual.js';
import { registerUpdateBudgetAmount } from './write/update-budget-amount.js';
import { registerTransferBetweenCategories } from './write/transfer-between-categories.js';
import { registerHoldForNextMonth } from './write/hold-for-next-month.js';
import { registerSetCategoryCarryover } from './write/set-category-carryover.js';
import { registerRecategorizeTransaction } from './write/recategorize-transaction.js';
import { registerCreateTransfer } from './write/create-transfer.js';
import { registerUpdateTransaction } from './write/update-transaction.js';
import { registerDeleteTransaction } from './write/delete-transaction.js';
import { registerRunBankSync } from './write/run-bank-sync.js';
import { registerRepairSync } from './write/repair-sync.js';
import { registerCreateAccount } from './write/create-account.js';
import { registerDeleteAccount } from './write/delete-account.js';
import { registerUpdateAccount } from './write/update-account.js';
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
import { withReadSync } from '../utils/read-sync.js';
import { withWriteNotice } from '../utils/write-notice.js';
import { withCurrentCurrency } from '../utils/currency.js';
import { withToolset } from '../utils/toolset.js';

/**
 * The tools this server actually offered, for whoever needs to know (#222).
 *
 * The prompts do: each one tells the model to call three or four tools by
 * name, and in the chat set two of those three prompts name nothing that is
 * there. Rather than keeping a second copy of the rule, they ask what was
 * registered, which is this.
 */
const offered = new Set<string>();

export function offeredTools(): ReadonlySet<string> {
  return offered;
}

/** Record what passes the toolset filter, without changing it. */
function withRecord<T extends { tool: (...args: never[]) => unknown }>(server: T): T {
  const wrapped = Object.create(server) as T;
  const originalTool = server.tool.bind(server) as (...args: unknown[]) => unknown;
  (wrapped as { tool: unknown }).tool = (...args: unknown[]) => {
    if (typeof args[0] === 'string') offered.add(args[0]);
    return originalTool(...args);
  };
  return wrapped;
}

export function registerAllTools(rawServer: McpServer): void {
  offered.clear();
  // Every read tool pulls the server's changes first (#126). Here rather than
  // in fifteen files: this is the one place they all go through.
  // Two wrappers, one per direction. Reads pull the server's changes first
  // (#126); writes re-read the budget currency, which scales the amount they
  // are about to convert (#141).
  // And `withInFlight` outside both, so leaving can wait for a call that is
  // half way through instead of closing the budget underneath it (#219).
  // `withToolset` outermost (#222). Inside the others it would behave the
  // same, since nothing is registered either way, but a tool the set does
  // not offer would be wrapped four times on its way to being dropped. The
  // decision is made once, at the top.
  const server = withToolset(
    withRecord(withInFlight(withWriteNotice(withReadSync(withCurrentCurrency(rawServer))))),
  );
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

  // Reads only, so read-only mode keeps it: it compares an account against a
  // bank figure and books nothing. Adjusting a balance is a separate decision,
  // and `reconcile_currency_residual` below is the tool that makes it.
  registerReconcileAccount(server);

  // Reads that live next to their write siblings below, registered here so
  // read-only mode keeps them.
  registerGetRules(server);

  // repair_sync stays available even read-only: it repairs sync state rather
  // than budget data, and hiding it would leave a desynced budget with no way
  // out — the situation that motivated #41.
  registerRepairSync(server);

  // Everything past this point writes. Read-only mode does not register these
  // at all, so they never reach tool discovery.
  if (isReadOnly()) return;

  // Write
  registerCreateTransaction(server);
  registerCreateTransactions(server);
  registerCreateSplitTransaction(server);
  registerReconcileCurrencyResidual(server);
  registerUpdateBudgetAmount(server);
  registerTransferBetweenCategories(server);
  registerHoldForNextMonth(server);
  registerSetCategoryCarryover(server);
  registerRecategorizeTransaction(server);
  registerCreateTransfer(server);
  registerUpdateTransaction(server);
  registerDeleteTransaction(server);
  registerRunBankSync(server);
  registerCreateAccount(server);
  registerDeleteAccount(server);
  registerUpdateAccount(server);

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
  registerCreateRule(server);
  registerDeleteRule(server);
}
