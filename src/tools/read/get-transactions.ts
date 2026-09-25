import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import * as api from '@actual-app/api';
import { ensureConnection } from '../../connection.js';
import { formatMoney } from '../../utils/money.js';
import { resolveDate } from '../../utils/dates.js';
import { resolveAccountId } from '../../utils/resolvers.js';
import { sectionHeader, formatTable } from '../../utils/formatters.js';
import { describeError } from '../../utils/errors.js';

export interface GetTransactionsInput {
  account?: string;
  start_date?: string;
  end_date?: string;
  category?: string;
  payee?: string;
  min_amount?: number;
  max_amount?: number;
  uncategorized?: boolean;
  limit?: number;
}

/**
 * Build the human-readable transactions report. Returns the formatted text.
 */
export async function getTransactionsReport(input: GetTransactionsInput): Promise<string> {
  const {
    account,
    start_date,
    end_date,
    category,
    payee,
    min_amount,
    max_amount,
    uncategorized,
    limit = 50,
  } = input;

  await ensureConnection();

  // "What still needs a category?" carries no date, and a month-wide default
  // answers it with "nothing" while transactions from March sit unsorted. With
  // the flag on and no dates given, look at everything and let `limit` bound
  // the answer; the report states the window it used.
  // Both ends, or the promise is false. Moving only the start said "searches
  // all dates" in three places while still stopping at today, and a
  // future-dated transaction — a scheduled one that has landed, a card charge
  // past the statement date — stayed invisible. Worse than before the change,
  // because the header now reads `1900-01-01 to ...` and looks exhaustive.
  const startDate = resolveDate(start_date || (uncategorized ? '1900-01-01' : 'start of month'));
  const endDate = uncategorized && !end_date ? '2099-12-31' : resolveDate(end_date);

  // Get accounts to query
  const allAccounts = await api.getAccounts();
  let accountIds: string[];

  if (account) {
    const id = await resolveAccountId(account);
    const named = allAccounts.find((a) => a.id === id);
    if (uncategorized && named?.offbudget) {
      // The engine forces `category = null` on every transaction of an
      // off-budget account, so all of them look unsorted and none of them can
      // ever be sorted: recategorising one succeeds and changes nothing.
      // Listing them would hand over work that cannot be finished.
      return (
        `"${named.name}" is an off-budget account, so its transactions do not take ` +
        'categories: Actual clears them. There is nothing here to categorise.'
      );
    }
    accountIds = [id];
  } else if (uncategorized) {
    // Off-budget accounts are left out unless one was asked for by name. Their
    // transactions have no category because none is wanted, so counting them as
    // work to do would bury the rows that really are waiting to be sorted.
    accountIds = allAccounts.filter((a) => !a.closed && !a.offbudget).map((a) => a.id);
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
    payee?: string | null;
    category?: string | null;
    amount: number;
    notes?: string | null;
    account: string;
    cleared?: boolean;
    is_parent?: boolean;
    parent_id?: string | null;
    subtransactions?: any[];
    transfer_id?: string | null;
  }> = [];

  for (const accId of accountIds) {
    const txns = await api.getTransactions(accId, startDate, endDate);

    for (const t of txns) {
      if ((t as any).is_parent && (t as any).subtransactions?.length > 0) {
        // Expand split transactions: show each sub-transaction with parent's date/payee
        for (const sub of (t as any).subtransactions) {
          allTransactions.push({
            ...sub,
            // The child's own id, not a composite. A composite reads well and
            // is useless: passing it to recategorize_transaction succeeds,
            // changes nothing, and reports success. A listed task that cannot
            // be completed is worse than one never listed.
            id: sub.id,
            date: t.date,
            payee: sub.payee || t.payee,
            // Cleared status is a property of the parent (bank-facing) transaction
            cleared: (t as any).cleared,
            notes: sub.notes ? `[Split] ${sub.notes}` : `[Split]`,
          });
        }
      } else if (!(t as any).is_child) {
        // Regular transaction (not a child of a split)
        allTransactions.push(t);
      }
    }
  }

  // Newest first, except when listing what still needs a category: there the
  // oldest are the ones most likely to be forgotten, and with `limit` at 50 a
  // backlog would push them past the end of the answer. The tool that exists to
  // surface what was overlooked should not start by hiding it.
  allTransactions.sort((a, b) =>
    uncategorized ? a.date.localeCompare(b.date) : b.date.localeCompare(a.date),
  );

  // Apply filters
  if (uncategorized) {
    // A transfer only loses its category when both sides sit on the same side
    // of the budget. Actual's rule, in `clearCategory`, is
    // `if (fromOffBudget === toOffBudget) { category: null }`, so a transfer
    // from a budgeted account to an off-budget one *keeps* its category and an
    // empty one there is a real gap.
    //
    // Treating every transfer as categoryless was wrong in the direction that
    // hides work: a monthly contribution from a budgeted account to an
    // off-budget investment account has exactly this shape, and a month where
    // it lost its category would have been reported as "nothing pending".
    const offBudgetById = new Map(allAccounts.map((a) => [a.id, Boolean(a.offbudget)]));
    const transferTargetByPayee = new Map(
      payees
        .filter((p) => (p as { transfer_acct?: string | null }).transfer_acct)
        .map((p) => [p.id, (p as { transfer_acct?: string | null }).transfer_acct as string]),
    );

    const isCategorylessTransfer = (t: {
      transfer_id?: string | null;
      payee?: string | null;
      account: string;
    }) => {
      if (!t.transfer_id) return false;
      const target = t.payee ? transferTargetByPayee.get(t.payee) : undefined;
      // Without the counterpart the engine's rule cannot be applied. Keeping
      // the row is the safe direction: one shown that needed nothing is
      // dismissed in a second; one hidden that needed sorting is never seen.
      if (!target) return false;
      return offBudgetById.get(target) === offBudgetById.get(t.account);
    };

    // What counts as "no category" was measured against the real engine rather
    // than assumed, because four different kinds of row report a null one:
    //
    //   - a plain transaction nobody has sorted yet  -> wanted
    //   - a split child with no category of its own  -> wanted
    //   - the parent of a split                      -> not wanted, its
    //     categories live on its parts, and the loop above has already
    //     replaced it with them
    //   - a transfer between two accounts on the same side of the budget
    //     -> not wanted; Actual clears the category on those. A transfer that
    //     crosses the budget boundary keeps its category, so an empty one
    //     there is a real gap and is listed
    //
    // Without the last two this would answer a question about tidying up with
    // a list of rows that are already exactly as they should be.
    allTransactions = allTransactions.filter(
      (t) => !t.category && !t.is_parent && !isCategorylessTransfer(t),
    );
  }

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
    return `No transactions found for the specified filters (${startDate} to ${endDate}).`;
  }

  const lines: string[] = [
    sectionHeader(`Transactions: ${startDate} to ${endDate}`),
    `Showing ${limited.length} of ${allTransactions.length} transactions`,
    '',
  ];

  // Cleared is appended after the existing columns to preserve backward compatibility.
  const headers = ['ID', 'Date', 'Payee', 'Category', 'Amount', 'Account', 'Notes', 'Cleared'];
  const rows = limited.map((t) => [
    t.id,
    t.date,
    t.payee ? payeeMap.get(t.payee) || '' : '',
    t.category ? categoryMap.get(t.category) || '' : '',
    formatMoney(t.amount),
    accountMap.get(t.account) || '',
    t.notes || '',
    t.cleared ? '✓' : '✗',
  ]);

  lines.push(
    formatTable(headers, rows, [
      'left',
      'left',
      'left',
      'left',
      'right',
      'left',
      'left',
      'left',
    ]),
  );

  // Total
  const total = limited.reduce((sum, t) => sum + t.amount, 0);
  lines.push('');
  lines.push(`Total: ${formatMoney(total)}`);

  return lines.join('\n');
}

export function registerGetTransactions(server: McpServer): void {
  server.tool(
    'get_transactions',
    'List transactions with optional filters. Returns date, payee, category, amount, notes, account, and cleared status.',
    {
      account: z
        .string()
        .optional()
        .describe('Account name or ID to filter by'),
      start_date: z
        .string()
        .optional()
        .describe(
          'Start date (YYYY-MM-DD or natural language like "start of month", "30 days ago"). Defaults to the start of the current month, or to every date when uncategorized is set.',
        ),
      end_date: z
        .string()
        .optional()
        .describe('End date (YYYY-MM-DD or natural language). Defaults to today, or to every date when uncategorized is set.'),
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
      uncategorized: z
        .boolean()
        .optional()
        .describe(
          'Only transactions with no category. Left out: split parents (their categories live on their parts), transfers between accounts on the same side of the budget (Actual clears those), and off-budget accounts (they take no categories at all). Searches all dates unless you give a range.',
        ),
      limit: z
        .number()
        .optional()
        .default(50)
        .describe('Maximum number of transactions to return (default 50)'),
    },
    { title: 'List transactions', readOnlyHint: true },
    async (input) => {
      try {
        const text = await getTransactionsReport(input);
        return { content: [{ type: 'text', text }] };
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
