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
import {
  findPossibleDuplicates,
  pullBeforeReading,
} from '../../utils/duplicate-check.js';
import { queueTransactionWrite } from '../../utils/transaction-writes.js';
import { describeError } from '../../utils/errors.js';
import { syncNow } from '../../utils/sync-clock.js';
import {
  findTransferTarget,
  isOffBudget,
  transferEffect,
  type TransferEffect,
} from '../../utils/transfer-rule.js';

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
 * ## A payee that names an account
 *
 * It is a transfer, by the same rule `create_transaction` applies, read from
 * the same module (#154). This used to be refused with "a batch cannot mix
 * transfers and ordinary rows", which was not true: `runTransfers` is a
 * per-call flag and a mixed call writes both kinds correctly. Measured through
 * this tool's own path, one account, three rows and the flag on:
 *
 *   payee_name + category + imported_id    kept, no counterpart
 *   transfer payee + category              counterpart created, category kept
 *   payee_name only                        kept, no counterpart
 *
 * The reply names the rows that became transfers at the end, once, rather than
 * repeating the explanation on each of them.
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
  /**
   * Set when the payee named another account, so this row is a transfer.
   * `payeeId` is filled in after the loop, from one `getPayees()` for the
   * whole batch rather than one per row.
   */
  transfer?: {
    targetId: string;
    targetName: string;
    targetOffBudget: boolean;
    sourceOffBudget: boolean;
    payeeId?: string;
  };
}

interface Problem {
  index: number;
  reason: string;
}

function describeRow(row: BatchInput, index: number): string {
  const bits = [
    `row ${index + 1}`,
    row.account,
    formatMoney(amountToCents(row.amount)),
  ];
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

  // Everything that touches the budget is inside the queue: not only the
  // write and the duplicate checks, but resolving the names too.
  //
  // Measured with calls sent together, and it is the same promise as the
  // rest of #111. `delete_account` finishing first left the batch holding
  // an id that no longer exists: it reported `Created 1 transaction.` and
  // the row went into the budget with `account: null` — an orphan nobody
  // can see, reported as a success. With `delete_category` and a
  // `transfer_to`, the row quietly landed in the other category and the
  // reply did not say so. The single-row tool resolves inside its own
  // queue and answers `No category found matching "Comida"` instead,
  // which is the behaviour this now matches.
  //
  // Called here rather than around the handler: `createTransactions` is
  // exported and used directly, and wrapping both would have the outer
  // call waiting on an inner one that cannot start.
  return await queueTransactionWrite(async () => {
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
          throw new Error(
            `amount must be a number, got ${JSON.stringify(row.amount)}`,
          );
        }
        const accountId = resolveAccountIn(accounts, row.account);
        const accountName =
          accounts.find((a) => a.id === accountId)?.name ?? row.account;

        // A payee naming another account means a transfer, by the same rule
        // `create_transaction` uses and read from the same place (#154).
        //
        // This used to refuse the row and send the caller to `create_transfer`
        // with the reason that a batch cannot mix transfers and ordinary rows.
        // That was not true. `runTransfers` is a per-call flag, and measured
        // through this tool's own path a mixed call writes both kinds
        // correctly: the ordinary rows keep their payee, category and
        // imported_id and get no counterpart, and the transfer rows get
        // theirs, with the category kept on the row it was asked for.
        const target = findTransferTarget({
          accounts,
          sourceAccountId: accountId,
          payee: row.payee,
          hasCategory: Boolean(row.category),
        });

        const categoryId = row.category
          ? resolveCategoryIn(categories, row.category)
          : undefined;

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
          transfer: target
            ? {
                targetId: target.id,
                targetName: target.name,
                targetOffBudget: target.offBudget,
                sourceOffBudget: isOffBudget(accounts.find((a) => a.id === accountId)),
              }
            : undefined,
        });
      } catch (error) {
        problems.push({ index, reason: describeError(error) });
      }
    }

    // One read for the batch, and only when there is a transfer in it: every
    // other row costs nothing. A missing transfer payee is a problem with that
    // row, not an exception that takes the batch down, so it joins the others
    // and gets reported with them.
    const transfers = resolved.filter((row) => row.transfer);
    if (transfers.length > 0) {
      const payees = await api.getPayees();
      for (const row of transfers) {
        const transferPayee = payees.find((p) => p.transfer_acct === row.transfer!.targetId);
        if (!transferPayee) {
          problems.push({
            index: row.index,
            reason: `no transfer payee found for account "${row.transfer!.targetName}".`,
          });
          continue;
        }
        row.transfer!.payeeId = transferPayee.id;
      }
    }

    // Two kinds of duplicate, and only one of them is a guess.
    //
    // A bank's `imported_id` is identity: the row either is that movement or
    // it is not. Account, date and amount is a heuristic, and a good one, but
    // two coffees of the same price on the same card on the same day are two
    // movements. That is what `allow_duplicate` is for, and it used to switch
    // off both -- so passing it wrote the same bank movement twice, in the
    // same call and against rows already in the budget, while the tool's
    // description promised resending could not duplicate it.
    //
    // The id is unique **per account**, which is how Actual's own bank sync
    // treats it: `WHERE imported_id = ? AND account = ?`, falling back to a
    // date-window match on amount within the same account. Without the
    // account in the key, the same `000123` from two banks in one batch
    // refused the whole batch and advised giving them different ids, which is
    // not something the person can do: the banks chose them.
    await pullBeforeReading('checking for transactions already recorded');

    // One complaint per row, whichever check finds it first: two complaints
    // about one row read as two problems and send the reader looking for two
    // fixes.
    const flagged = new Set<number>();
    const complain = (index: number, reason: string) => {
      if (flagged.has(index)) return;
      flagged.add(index);
      problems.push({ index, reason });
    };

    // Identity, so no escape: `allow_duplicate` does not reach these.
    const seenIds = new Map<string, number>();
    for (const row of resolved) {
      if (!row.importedId) continue;
      const key = `${row.accountId}|${row.importedId}`;
      const first = seenIds.get(key);
      if (first !== undefined) {
        complain(
          row.index,
          `repeats row ${first + 1}: same imported_id "${row.importedId}" on the same ` +
            `account. A bank id identifies one movement, so two rows carrying it in one ` +
            `account are the same one twice. If they really are different movements, give ` +
            `them different ids.`,
        );
      } else {
        seenIds.set(key, row.index);
      }
    }

    const importedIds = resolved.map((r) => r.importedId).filter((id): id is string => !!id);
    if (importedIds.length > 0) {
      const existing = await api.runQuery(
        transactionsQuery('all')
          .filter({ imported_id: { $oneof: importedIds } })
          .select(['imported_id', 'account']),
      );
      // The account comes back with it, because the same id in another account
      // is another movement and refusing it would be wrong.
      const found = new Set(
        ((existing as { data?: Array<{ imported_id?: string; account?: string }> }).data ?? [])
          .filter((r) => r.imported_id && r.account)
          .map((r) => `${r.account}|${r.imported_id}`),
      );
      for (const row of resolved) {
        if (row.importedId && found.has(`${row.accountId}|${row.importedId}`)) {
          complain(
            row.index,
            `imported_id "${row.importedId}" is already in ${row.accountName}, so this row ` +
              `has been recorded before. If your bank reused the id and this is a different ` +
              `movement, send it without an imported_id, or with one of your own.`,
          );
        }
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
          complain(
            row.index,
            `repeats row ${first + 1}: same account, date and amount. If both really happened, pass allow_duplicate.`,
          );
        } else {
          seen.set(key, row.index);
        }
      }

      for (const row of resolved) {
        const existing = await findPossibleDuplicates(
          row.accountId,
          row.date,
          row.amountCents,
          { alreadyPulled: true },
        );
        if (existing.length > 0) {
          complain(
            row.index,
            `${row.accountName} already has a transaction on ${row.date} for ` +
              `${formatMoney(row.amountCents)}. If this is a second one, pass allow_duplicate.`,
          );
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
        // "Fix them and send the same list again" is good advice for a bad
        // category or an unusable amount. It is wrong for a row whose id is
        // already recorded: that row is not broken, it is done, and the fix is
        // to drop it rather than to correct it. Telling someone to fix it
        // invites them to change the id, which writes the movement twice.
        const alreadyRecorded = problems.some((p) => p.reason.includes('has been recorded before'));
        lines.push(
          '',
          `The other ${untouched} row${untouched === 1 ? ' was' : 's were'} fine and ${untouched === 1 ? 'was' : 'were'} not written either: the batch is all or nothing,`,
          alreadyRecorded
            ? 'so send the list again without the rows that are already recorded, and fix any others.'
            : 'so fixing the rows above and sending the same list again creates every one of them.',
        );
      }
      return lines;
    }

    return await writeBatch(resolved, rows.length);
  });
}

async function writeBatch(
  resolved: ResolvedRow[],
  total: number,
): Promise<string[]> {
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
    const rows = await api.getTransactions(
      accountId,
      '1900-01-01',
      '2999-12-31',
    );
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
      // A transfer goes through the other account's transfer payee, not by
      // name: that is what links the two rows. Everything else keeps its
      // payee_name, in the same call.
      if (row.transfer?.payeeId) transaction.payee = row.transfer.payeeId;
      else if (row.payee) transaction.payee_name = row.payee;
      if (row.categoryId) transaction.category = row.categoryId;
      if (row.notes) transaction.notes = row.notes;
      if (row.importedId) transaction.imported_id = row.importedId;
      return transaction;
    });

    try {
      // `learnCategories: false` for the same reason as the single-row tool:
      // the learned payee→category mapping is applied on add and would
      // silently replace an explicit category (#26).
      // Per call, not per row, so it is on whenever this account's group has a
      // transfer in it. Measured: with it on, the ordinary rows in the same
      // call keep their payee, category and imported_id and get no
      // counterpart. Leaving it off for a group that has one would write a
      // one-legged movement, which is the thing worth refusing.
      await api.addTransactions(accountId, payload as never, {
        learnCategories: false,
        runTransfers: group.some((row) => row.transfer?.payeeId),
      });
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
    const found =
      (result as { data?: Array<Record<string, unknown>> }).data ?? [];
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

  await syncNow();

  const lines: string[] = [];
  const counts: string[] = [];
  for (const accountId of byAccount.keys()) {
    const rows = await api.getTransactions(
      accountId,
      '1900-01-01',
      '2999-12-31',
    );
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
  lines.push(...describeTransfers(written));
  return lines;
}

/** What each label in the summary means, said once however many rows earned it. */
const EFFECT_LABEL: Record<TransferEffect, string> = {
  inside: 'inside your budget',
  outside: 'outside your budget',
  incoming: 'came into your budget',
  outgoing: 'left your budget',
};

const EFFECT_PARAGRAPH: Record<TransferEffect, string> = {
  inside:
    'Inside your budget means the money only changed account, so it is not spending. To ' +
    'record a purchase instead, give the row a category and use a payee that is not an ' +
    'account name.',
  outside:
    'Outside your budget means both accounts are off budget, so your budget is not ' +
    'affected at all.',
  incoming:
    'Came into your budget means one of the two accounts is off budget and the money came ' +
    'from there.',
  outgoing:
    'Left your budget means one of the two accounts is off budget and the money went that ' +
    'way.',
};

/**
 * Name the rows that turned into transfers, at the end, once.
 *
 * The caller wrote a payee and got something else, and in #137 the person did
 * not find out until they went looking for spending they thought they had
 * recorded. Saying it per row would repeat the same paragraph up to twenty
 * times in one reply, so the rows are listed and the explanation follows once
 * per kind of effect that actually occurred.
 */
function describeTransfers(written: ResolvedRow[]): string[] {
  const transfers = written.filter((row) => row.transfer?.payeeId);
  if (transfers.length === 0) return [];

  const entries = transfers.map((row) => {
    const effect = transferEffect({
      amountCents: row.amountCents,
      sourceOffBudget: row.transfer!.sourceOffBudget,
      targetOffBudget: row.transfer!.targetOffBudget,
    });
    // Direction from the sign, not from which account the row was written to:
    // a positive amount is money arriving, so the other account is where it
    // came from. Reading it the other way says the opposite of what the engine
    // did, which is the mistake #137 made twice.
    const route =
      row.amountCents >= 0
        ? `${row.transfer!.targetName} -> ${row.accountName}`
        : `${row.accountName} -> ${row.transfer!.targetName}`;
    return { index: row.index, route, amount: Math.abs(row.amountCents), effect, row };
  });

  const routeWidth = Math.max(...entries.map((e) => e.route.length));
  const amountWidth = Math.max(...entries.map((e) => formatMoney(e.amount).length));

  const count = entries.length;
  const lines = [
    '',
    `${count} of them named one of your accounts, so ${count === 1 ? 'it was' : 'they were'} ` +
      `recorded as ${count === 1 ? 'a transfer' : 'transfers'} and a matching row was created ` +
      `in the other account:`,
    '',
    ...entries.map(
      (e) =>
        `  row ${e.index + 1}  ${e.route.padEnd(routeWidth)}  ` +
        `${formatMoney(e.amount).padStart(amountWidth)}  ${EFFECT_LABEL[e.effect]}`,
    ),
  ];

  // One paragraph per kind that happened, in a fixed order so two replies about
  // the same batch read the same way.
  const kinds: TransferEffect[] = ['inside', 'outgoing', 'incoming', 'outside'];
  for (const kind of kinds) {
    if (entries.some((e) => e.effect === kind)) {
      lines.push('', EFFECT_PARAGRAPH[kind]);
    }
  }

  // Only when there is a category to talk about, and the two cases are not the
  // same thing. On a row that crosses the edge of the budget the category is
  // kept where it was asked for; between two off-budget accounts Actual
  // removes it, which #137 recorded the other way round because it read the
  // row before the engine had finished with it.
  const crossing = entries.filter(
    (e) => (e.effect === 'incoming' || e.effect === 'outgoing') && e.row.categoryId,
  );
  if (crossing.length > 0) {
    lines.push(
      '',
      'The category on a row that crossed the edge stays where you asked for it, and counts ' +
        'only if that row is in an account that is in your budget.',
    );
  }

  const outside = entries.filter((e) => e.effect === 'outside' && e.row.categoryId);
  if (outside.length > 0) {
    lines.push(
      '',
      `The category on ${outside.length === 1 ? 'the row that is outside your budget was' : 'the rows that are outside your budget were'} ` +
        'not kept: Actual discards a category on a transfer where neither account is in the ' +
        'budget, since nothing could count it.',
    );
  }

  return lines;
}

export function registerCreateTransactions(server: McpServer): void {
  server.tool(
    'create_transactions',
    'Create several transactions in one call. This is the way to record more than one: ' +
      'the rows are validated first and written together, so nothing is created unless every ' +
      'row is usable. Calling create_transaction many times in parallel is what this replaces. ' +
      'A row whose payee names one of your accounts becomes a transfer, the same way ' +
      'create_transaction treats it, so a month of records can be sent as one list.',
    {
      transactions: z
        .array(
          z.object({
            account: z.string().describe('Account name or ID'),
            amount: z
              .number()
              .describe(
                'Human-readable amount, negative for expenses, positive for income',
              ),
            payee: z
              .string()
              .optional()
              .describe(
                'Payee name, or the name of one of your accounts to make a transfer, the ' +
                  'same way create_transaction does. Giving a category turns it into an ' +
                  'ordinary purchase instead, but only when both accounts are on budget.',
              ),
            category: z.string().optional().describe('Category name or ID'),
            date: z
              .string()
              .optional()
              .describe('YYYY-MM-DD or natural language. Defaults to today.'),
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
        .describe(
          'The transactions to create. All of them are written, or none.',
        ),
      allow_duplicate: z
        .boolean()
        .optional()
        .describe(
          'Create the rows even though some repeat each other or match transactions already in the budget. Without this, such a batch is reported and nothing is written.',
        ),
    },
    {
      title: 'Create several transactions',
      readOnlyHint: false,
      idempotentHint: false,
    },
    async (input) => {
      try {
        const lines = await createTransactions(input as never);
        return { content: [{ type: 'text', text: lines.join("\n") }] };
      } catch (error) {
        return {
          content: [{ type: 'text', text: `Error: ${describeError(error)}` }],
          isError: true,
        };
      }
    },
  );
}
