import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import * as api from '@actual-app/api';
import { ensureConnection } from '../../connection.js';
import { amountToCents, formatMoney } from '../../utils/money.js';
import { resolveDate } from '../../utils/dates.js';
import { resolveAccountIn, resolveCategoryIn } from '../../utils/resolvers.js';
import { transactionsQuery } from '../../utils/transaction-query.js';
import { newWriteMarker } from '../../utils/write-marker.js';
import { updatePreservingChildAmount } from '../../utils/transactions.js';
import { findPossibleDuplicates, pullBeforeReading } from '../../utils/duplicate-check.js';
import { queueTransactionWrite } from '../../utils/transaction-writes.js';
import { describeError } from '../../utils/errors.js';

/**
 * Create many transactions in one call.
 *
 * One at a time was the only thing that worked: the 22 movements of a single
 * day were 22 calls, and nine at once took the server down, which is how that
 * limit was learned (#83). So the choice was slow or broken, and this removes
 * the reason to reach for the broken one.
 *
 * ## All of them or none of them, decided by measurement
 *
 * Against the engine, one case at a time, counting the account's rows before
 * and after `addTransactions` with one bad row among good ones:
 *
 *   3 valid rows                    "ok"     +3 of 3
 *   a nonexistent category id       "ok"     +3 of 3
 *   a malformed date                throws    0 of 2
 *   a row with no date              throws    0 of 2
 *   a non-integer amount            throws    0 of 2
 *   two identical rows              "ok"     +2 of 2
 *
 * The engine is **already** all-or-nothing for what it validates: a bad date
 * anywhere writes nothing at all, not even the good rows before it. So this is
 * not a policy imposed on it; a best-effort design would have to work against
 * it, and would mean one write per row, which is the problem again.
 *
 * What it does *not* check is what this has to: a category id that does not
 * exist is accepted and written, and two identical rows in one array both land.
 * So every row is resolved and checked here, before the single write, and if
 * any row fails, nothing is sent. The report then says which row failed and
 * why, and marks the rest as not written *because of it* rather than as
 * failures of their own.
 *
 * ## One call per account, which is where atomicity ends
 *
 * `addTransactions(accountId, rows)` writes to the account it is given:
 * measured, a row carrying its own `account` field was ignored and went to the
 * account in the argument. A batch spanning two accounts is therefore two
 * writes, and if the second fails the first has already landed. Everything is
 * validated first precisely to make that unlikely, and if it happens the reply
 * says what landed rather than reporting a clean failure (#79).
 *
 * ## `imported_id` does not deduplicate here
 *
 * Measured: the same `imported_id` sent twice through `addTransactions`
 * produced two rows. `importTransactions` does deduplicate, but it also does
 * fuzzy matching and can update existing rows, which is a different operation
 * from "create these". So the guarantee is provided the same way as every other
 * check: rows whose `imported_id` is already in the budget are found before
 * writing, and the batch is refused. A retry of the same batch cannot duplicate
 * because the second attempt sees the first one's rows.
 */

/** One row as the caller wrote it. */
interface BatchInput {
  account: string;
  amount: number;
  payee?: string;
  category?: string;
  date?: string;
  notes?: string;
  cleared?: boolean;
  imported_id?: string;
}

/** One row once every name in it has been turned into an id. */
interface ResolvedRow {
  index: number;
  accountId: string;
  accountName: string;
  date: string;
  amountCents: number;
  categoryId?: string;
  payee?: string;
  notes?: string;
  cleared: boolean;
  importedId?: string;
  marker: string;
}

interface Problem {
  index: number;
  reason: string;
}

/**
 * The queue every transaction write shares (#111). It was this tool's own at
 * first, which stopped two batches interleaving but left a batch free to race
 * a single create or a delete.
 */
const queue = queueTransactionWrite;

function describeRow(row: BatchInput, index: number): string {
  const bits = [`row ${index + 1}`, row.account, formatMoney(amountToCents(row.amount))];
  if (row.payee) bits.push(row.payee);
  if (row.date) bits.push(row.date);
  return bits.join('  ');
}

export async function createTransactions(input: {
  transactions: BatchInput[];
  allow_duplicate?: boolean;
}): Promise<string[]> {
  await ensureConnection();

  const rows = input.transactions;
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new Error('No transactions were given, so nothing was created.');
  }

  // Loaded once for the whole batch rather than once per row: for 22 rows that
  // is the difference between 2 reads and 44.
  const accounts = await api.getAccounts();
  const categories = await api.getCategories();

  const problems: Problem[] = [];
  const resolved: ResolvedRow[] = [];

  for (const [index, row] of rows.entries()) {
    try {
      if (!row || typeof row !== 'object') {
        throw new Error('is not a transaction object');
      }
      if (!Number.isFinite(row.amount)) {
        throw new Error(`amount must be a number, got ${JSON.stringify(row.amount)}`);
      }
      const accountId = resolveAccountIn(accounts, row.account);
      const accountName = accounts.find((a) => a.id === accountId)?.name ?? row.account;

      // A payee naming another account means a transfer, which needs both
      // sides linked and `runTransfers` on the write. That is a per-call flag,
      // not a per-row one, so a batch cannot carry a mix. Refused rather than
      // written as an ordinary payee, which would leave one-legged movements.
      if (row.payee) {
        const lower = row.payee.toLowerCase();
        const target = accounts.find(
          (a) => !a.closed && (a.id === row.payee || a.name.toLowerCase() === lower),
        );
        if (target) {
          throw new Error(
            `payee "${row.payee}" names an account, which makes this a transfer. ` +
              `Use create_transfer for it; a batch cannot mix transfers and ordinary rows.`,
          );
        }
      }

      const categoryId = row.category ? resolveCategoryIn(categories, row.category) : undefined;

      resolved.push({
        index,
        accountId,
        accountName,
        date: resolveDate(row.date),
        amountCents: amountToCents(row.amount),
        categoryId,
        payee: row.payee,
        notes: row.notes,
        cleared: row.cleared ?? false,
        importedId: row.imported_id,
        marker: newWriteMarker(),
      });
    } catch (error) {
      problems.push({ index, reason: describeError(error) });
    }
  }

  if (!input.allow_duplicate) {
    // Two rows in the same call that are the same movement. The existing
    // duplicate check asks about rows already in the budget (#88), and two
    // identical rows arriving together is a case it has never seen, because
    // until now they could not arrive together. Measured: the engine writes
    // both.
    //
    // Inside this branch, not before it: the message tells the caller to pass
    // `allow_duplicate`, and for a turn that advice led nowhere, because the
    // check ran either way and refused the batch again. A test asking for the
    // way out is what found it.
    const seen = new Map<string, number>();
    for (const row of resolved) {
      const key = `${row.accountId}|${row.date}|${row.amountCents}`;
      const first = seen.get(key);
      if (first !== undefined) {
        problems.push({
          index: row.index,
          reason: `repeats row ${first + 1}: same account, date and amount. If both really happened, pass allow_duplicate.`,
        });
      } else {
        seen.set(key, row.index);
      }
    }

    // `imported_id` is not deduplicated by the engine on this path, measured,
    // so a row whose id is already here is found rather than written twice.
    const importedIds = resolved.map((r) => r.importedId).filter((id): id is string => !!id);
    if (importedIds.length > 0) {
      await pullBeforeReading('checking for transactions already imported');
      const existing = await api.runQuery(
        transactionsQuery('all')
          .filter({ imported_id: { $oneof: importedIds } })
          .select(['imported_id']),
      );
      const found = new Set(
        ((existing as { data?: Array<{ imported_id?: string }> }).data ?? []).map(
          (r) => r.imported_id,
        ),
      );
      for (const row of resolved) {
        if (row.importedId && found.has(row.importedId)) {
          problems.push({
            index: row.index,
            reason: `imported_id "${row.importedId}" is already in the budget, so this row has been recorded before.`,
          });
        }
      }
    }

    for (const row of resolved) {
      const existing = await findPossibleDuplicates(row.accountId, row.date, row.amountCents);
      if (existing.length > 0) {
        problems.push({
          index: row.index,
          reason:
            `${row.accountName} already has a transaction on ${row.date} for ` +
            `${formatMoney(row.amountCents)}. If this is a second one, pass allow_duplicate.`,
        });
      }
    }
  }

  if (problems.length > 0) {
    problems.sort((a, b) => a.index - b.index);
    const failed = new Set(problems.map((p) => p.index));
    const lines = [
      `Nothing was created. ${problems.length} of ${rows.length} rows could not be used:`,
      '',
    ];
    for (const problem of problems) {
      lines.push(`  ${describeRow(rows[problem.index], problem.index)}`);
      lines.push(`      ${problem.reason}`);
    }
    const untouched = rows.length - failed.size;
    if (untouched > 0) {
      lines.push(
        '',
        `The other ${untouched} row${untouched === 1 ? ' was' : 's were'} fine and ${untouched === 1 ? 'was' : 'were'} not written either: the batch is all or nothing,`,
        'so fixing the rows above and sending the same list again creates every one of them.',
      );
    }
    return lines;
  }

  return await queue(() => writeBatch(resolved, rows.length));
}

async function writeBatch(resolved: ResolvedRow[], total: number): Promise<string[]> {
  // Grouped because `addTransactions` writes to the account it is given, not
  // to one named on the row: measured, a row carrying its own `account` went
  // to the account in the argument instead.
  const byAccount = new Map<string, ResolvedRow[]>();
  for (const row of resolved) {
    const group = byAccount.get(row.accountId);
    if (group) group.push(row);
    else byAccount.set(row.accountId, [row]);
  }

  const before = new Map<string, number>();
  for (const accountId of byAccount.keys()) {
    const rows = await api.getTransactions(accountId, '1900-01-01', '2999-12-31');
    before.set(accountId, rows.length);
  }

  const written: ResolvedRow[] = [];
  let failure: { accountName: string; message: string } | undefined;

  for (const [accountId, group] of byAccount) {
    const payload = group.map((row) => {
      const transaction: Record<string, unknown> = {
        id: row.marker,
        date: row.date,
        amount: row.amountCents,
        cleared: row.cleared,
      };
      if (row.payee) transaction.payee_name = row.payee;
      if (row.categoryId) transaction.category = row.categoryId;
      if (row.notes) transaction.notes = row.notes;
      if (row.importedId) transaction.imported_id = row.importedId;
      return transaction;
    });

    try {
      // `learnCategories: false` for the same reason as the single-row tool:
      // the learned payee→category mapping is applied on add and would
      // silently replace an explicit category (#26).
      await api.addTransactions(accountId, payload as never, { learnCategories: false });
      written.push(...group);
    } catch (error) {
      failure = {
        accountName: group[0].accountName,
        message: describeError(error),
      };
      break;
    }
  }

  // The learned mapping can still have overridden an explicit category on the
  // way in, so the rows are found by the ids they were given and corrected.
  // One query for the whole batch rather than one per row.
  const wantCategory = written.filter((row) => row.categoryId);
  if (wantCategory.length > 0) {
    const result = await api.runQuery(
      transactionsQuery('all')
        .filter({ id: { $oneof: wantCategory.map((r) => r.marker) } })
        .select(['id', 'category', 'amount', 'is_parent']),
    );
    const found = (result as { data?: Array<Record<string, unknown>> }).data ?? [];
    const byId = new Map(found.map((r) => [String(r.id), r]));
    for (const row of wantCategory) {
      const actual = byId.get(row.marker);
      if (!actual) continue;
      if (actual.is_parent === true) {
        console.error(
          `[create_transactions] warning: a rule turned row ${row.index + 1} into a split, and a split's category lives on its parts, so the category asked for was not applied.`,
        );
        continue;
      }
      if (actual.category !== row.categoryId) {
        await updatePreservingChildAmount(row.marker, {
          category: row.categoryId,
          amount: Number(actual.amount),
        });
      }
    }
  }

  await api.sync();

  const lines: string[] = [];
  const counts: string[] = [];
  for (const accountId of byAccount.keys()) {
    const rows = await api.getTransactions(accountId, '1900-01-01', '2999-12-31');
    const name = byAccount.get(accountId)![0].accountName;
    counts.push(`  ${name}: ${before.get(accountId)} -> ${rows.length}`);
  }

  if (failure) {
    lines.push(
      `The batch stopped part way through, at ${failure.accountName}: ${failure.message}`,
      '',
      `${written.length} of ${total} rows were written before it stopped, and they are still there.`,
      'A write that reports failure may have applied (#79), so these are the counts as they',
      'stand now rather than what was intended:',
      ...counts,
      '',
      'Do not resend the whole list: the rows above would be created a second time.',
    );
    return lines;
  }

  lines.push(
    `Created ${written.length} transaction${written.length === 1 ? '' : 's'}.`,
    '',
    'Transactions on each account, before and after:',
    ...counts,
  );
  return lines;
}

export function registerCreateTransactions(server: McpServer): void {
  server.tool(
    'create_transactions',
    'Create several transactions in one call. This is the way to record more than one: ' +
      'the rows are validated first and written together, so nothing is created unless every ' +
      'row is usable. Calling create_transaction many times in parallel is what this replaces.',
    {
      transactions: z
        .array(
          z.object({
            account: z.string().describe('Account name or ID'),
            amount: z
              .number()
              .describe('Human-readable amount, negative for expenses, positive for income'),
            payee: z.string().optional().describe('Payee name. Naming an account is a transfer, which a batch refuses: use create_transfer.'),
            category: z.string().optional().describe('Category name or ID'),
            date: z.string().optional().describe('YYYY-MM-DD or natural language. Defaults to today.'),
            notes: z.string().optional(),
            cleared: z.boolean().optional(),
            imported_id: z
              .string()
              .optional()
              .describe(
                "The bank's own id for this movement, if you have one. A row whose imported_id is already in the budget is refused, so resending a batch cannot duplicate it.",
              ),
          }),
        )
        .describe('The transactions to create. All of them are written, or none.'),
      allow_duplicate: z
        .boolean()
        .optional()
        .describe(
          'Create the rows even though some repeat each other or match transactions already in the budget. Without this, such a batch is reported and nothing is written.',
        ),
    },
    { title: 'Create several transactions', readOnlyHint: false, idempotentHint: false },
    async (input) => {
      try {
        const lines = await createTransactions(input as never);
        return { content: [{ type: 'text', text: lines.join('\n') }] };
      } catch (error) {
        return {
          content: [{ type: 'text', text: `Error: ${describeError(error)}` }],
          isError: true,
        };
      }
    },
  );
}
