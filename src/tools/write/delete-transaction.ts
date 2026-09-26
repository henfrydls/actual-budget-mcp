import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import * as api from '@actual-app/api';
import { ensureConnection } from '../../connection.js';
import { formatMoney } from '../../utils/money.js';
import { describeError } from '../../utils/errors.js';
import { requireConfirmation } from '../../utils/confirm.js';
import { transactionsQuery } from '../../utils/transaction-query.js';

export interface DeleteTransactionInput {
  transaction_id: string;
  confirm?: boolean;
}

/**
 * Delete a transaction, behind the shared confirmation guard.
 *
 * No `confirm_name` here: the target is an exact id, so there is no
 * wrong-target ambiguity for a name echo to catch and requiring one would be
 * empty ceremony. The preview carries the weight instead — it shows the
 * transaction so the caller can see whether it is the one they meant.
 */
export async function deleteTransactionGuarded(
  input: DeleteTransactionInput,
): Promise<{ deleted: boolean; lines: string[] }> {
  await ensureConnection();

  // One lookup, by the id the caller gave, and nothing else.
  //
  // What was here scanned every open account between a date floor and today,
  // which is four separate narrowings of a question that has none. Each one
  // hid a row that exists, and every one of them still deleted on confirm, so
  // the guard was not refusing: it was asking the caller to confirm a blank.
  // Measured against the engine, all four previewed nothing:
  //
  //   dated after today   a card purchase posted by the bank on a later day,
  //                       which is ordinary rather than exotic
  //   dated before 2000   the floor was 2000-01-01 here, while the other
  //                       delete tools use 1900-01-01
  //   a split child       `getTransactions` fixes `splits: 'grouped'`, so a
  //                       child is nested inside its parent and never appears
  //                       as a row to match on
  //   a closed account    skipped outright, and the message said so, which
  //                       made one of the four look intended
  //
  // A fifth followed from the same place: an id that matches nothing reached
  // the delete and reported "Transaction <id> deleted."
  //
  // `splits: 'all'` so children and parents are both visible; the AQL path has
  // no date window and no notion of an account being closed, so asking by id
  // is both the simplest question and the only one that is actually being
  // asked. It is also one query instead of one per account.
  //
  // `all` rather than `inline`, and the difference that matters is narrower
  // than "the default hides things": measured, `inline` returns a split child
  // perfectly well. It is `grouped`, which `api.getTransactions` fixes
  // internally, that resolves a child id to its *parent*, which is how the old
  // scan lost children: it compared ids, the parent's id differed, and the row
  // came back as missing.
  //
  // A note on what this does NOT guard against, because an earlier version of
  // this comment claimed the opposite as measured fact and was wrong.
  //
  // It said that filtering by `id` bypasses AQL's exclusion of deleted rows,
  // and carried a table showing a deleted row returned by an id filter and not
  // by an account+date+amount one. The table was real; the conclusion was not.
  // Running the same two queries in the other order shows the id filter
  // returning zero and the other returning one, so what varied was the
  // position, not the filter. Measured four ways: whichever query runs first
  // after a delete returns the stale row, a second identical query returns
  // nothing, querying any other id first also clears it, and a 300 ms pause
  // clears it. It is a deferred write window, and no filter closes it.
  //
  // The consequence is real and is left in place deliberately: deleting the
  // same id twice in immediate succession reports success twice, the second
  // time previewing a row that is already gone. A third call refuses
  // correctly. In this server a real `api.sync()` sits between the two, which
  // makes the window hard to reach, and the cost of the row being gone twice
  // is nothing. Re-reading after the delete would close it and is not worth a
  // second round trip on every deletion.
  //
  // The same window reaches further than this tool, and that is filed rather
  // than patched here: after a delete, the next `findPossibleDuplicates` (#88)
  // returns the deleted row and the one after it returns nothing. An earlier
  // version of this comment said that check was unaffected because it filters
  // on account, date and amount rather than id. Wrong for the same reason as
  // the rest: what protects a query is not its filter, it is being the second
  // one rather than the first.
  const result = await api.runQuery(
    transactionsQuery('all')
      .filter({ id: input.transaction_id })
      .select(['id', 'date', 'amount', 'payee', 'category', 'account', 'is_parent', 'is_child']),
  );
  const rows = (result as { data?: Array<Record<string, unknown>> } | undefined)?.data;
  const found = Array.isArray(rows) ? rows[0] : undefined;

  // Nothing to delete is not something to confirm. Reporting a deletion that
  // did not happen teaches a caller that the id was wrong in some harmless
  // way, when it may be the one thing that would have told them the row had
  // already gone.
  if (!found) {
    return {
      deleted: false,
      lines: [
        `No transaction with id ${input.transaction_id} exists in this budget, so nothing was deleted.`,
        'Check the id with get_transactions. This lookup covers every account, open or closed,',
        'every date, and the parts of a split, so a missing row is genuinely missing.',
      ],
    };
  }

  const accounts = await api.getAccounts();
  const categories = await api.getCategories();
  const categoryMap = new Map(categories.filter((c) => 'group_id' in c).map((c) => [c.id, c.name]));
  const payees = await api.getPayees();
  const payeeMap = new Map(payees.map((p) => [p.id, p.name]));

  const acct = accounts.find((a) => a.id === found.account);
  const payeeName = found.payee ? payeeMap.get(String(found.payee)) || '' : '';
  const catName = found.category ? categoryMap.get(String(found.category)) || '' : '';
  const isSplitParent = found.is_parent === true;

  const details: string[] = [
    `  Date:     ${String(found.date)}`,
    `  Amount:   ${formatMoney(Number(found.amount))}`,
    ...(payeeName ? [`  Payee:    ${payeeName}`] : []),
    ...(catName ? [`  Category: ${catName}`] : []),
    `  Account:  ${acct?.name ?? String(found.account)}${acct?.closed ? ' (closed)' : ''}`,
  ];

  if (isSplitParent) {
    details.push('', 'This is a split parent: all of its child transactions are deleted with it.');
  }
  if (found.is_child === true) {
    // The amount above is a share, not the purchase, and removing it does more
    // than remove that share. Measured on a -70.00 split of -40.00 and -30.00,
    // deleting the -40.00 part: the account balance moves from -70.00 to
    // -30.00, the parent still states -70.00 while its parts now sum to
    // -30.00, and the parent is left carrying a SplitTransactionError. Saying
    // only "the other parts stay" would be true and would leave out the whole
    // of what goes wrong.
    details.push(
      '',
      'This is one part of a split, not the whole transaction.',
      `Deleting it moves the account balance by ${formatMoney(-Number(found.amount))},`,
      'and leaves the parent stating a total its parts no longer add up to,',
      'flagged as a split error until the parent is corrected or deleted too.',
    );
  }

  const confirmation = requireConfirmation({
    subject: `Transaction: ${input.transaction_id}`,
    losses: details,
    input,
  });

  if (!confirmation.confirmed) {
    return { deleted: false, lines: confirmation.lines };
  }

  await api.deleteTransaction(input.transaction_id);
  await api.sync();

  return {
    deleted: true,
    lines: [`Transaction ${input.transaction_id} deleted.`, 'Deleted transaction:', ...details],
  };
}

export function registerDeleteTransaction(server: McpServer): void {
  server.tool(
    'delete_transaction',
    'Delete a transaction by its ID. Destructive and irreversible: the first call only ' +
      'previews what would be lost, and deleting requires confirm: true.',
    {
      transaction_id: z.string().describe('Transaction ID to delete'),
      confirm: z
        .boolean()
        .optional()
        .describe('Must be true to delete. Without it, the tool only previews.'),
    },
    { title: 'Delete transaction', readOnlyHint: false, destructiveHint: true },
    async (input) => {
      try {
        const { deleted, lines } = await deleteTransactionGuarded(input);
        return {
          content: [{ type: 'text' as const, text: lines.join('\n') }],
          ...(deleted ? {} : { isError: true }),
        };
      } catch (error) {
        return {
          content: [{ type: 'text' as const, text: `Error: ${describeError(error)}` }],
          isError: true,
        };
      }
    },
  );
}
