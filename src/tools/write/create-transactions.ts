import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import * as api from '@actual-app/api';
import { ensureConnection } from '../../connection.js';
import { amountToCents, formatMoney } from '../../utils/money.js';
import { resolveDate } from '../../utils/dates.js';
import { resolveAccountIn, resolveCategoryIn } from '../../utils/resolvers.js';
import { transactionsQuery } from '../../utils/transaction-query.js';
import {
  newWriteMarker,
  findSavedRowsByMarker,
  findSavedParts,
  type SavedRow,
} from '../../utils/write-marker.js';
import {
  changesMadeByRules,
  describeChange,
  listChanges,
  rowForComparison,
  type AskedRow,
} from '../../utils/rule-changes.js';
import { updatePreservingChildAmount } from '../../utils/transactions.js';
import {
  findPossibleDuplicates,
  findUnlinkedCounterpart,
  pullBeforeReading,
  COUNTERPART_WINDOW_DAYS,
} from '../../utils/duplicate-check.js';
import { queueTransactionWrite } from '../../utils/transaction-writes.js';
import { describeError } from '../../utils/errors.js';
import { syncNow } from '../../utils/sync-clock.js';
import {
  findTransferTarget,
  isOffBudget,
  transferPairKey,
} from '../../utils/transfer-rule.js';
import {
  transferLegs,
  requestedLeg,
  clearsCategory,
  effectParagraphs,
  legTable,
} from '../../utils/transfer-legs.js';
import { pairCounterparts } from '../../utils/counterpart-pairing.js';

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
 * Two checks come with them, because a transfer writes two rows and the
 * existing checks only ever looked at one. Both halves of one movement in the
 * same list, which is what reading a card payment off both statements gives,
 * are refused as one movement written twice; and a transfer whose other side
 * is already sitting in the target account, imported from the bank, is refused
 * before it lands on top of it.
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
  /** Let this one row through the approximate duplicate checks (#175). */
  allow_duplicate?: boolean;
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
  /** Set by the row or by the call: what the approximate checks find is a note. */
  allowDuplicate: boolean;
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
          allowDuplicate: Boolean(row.allow_duplicate || input.allow_duplicate),
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
    //
    // Refused and noted are two sets, not one. A row that was only noted is
    // still going in, so the checks that skip rows already reported must not
    // skip it: with one set, a noted transfer stopped being paired with the
    // ordinary row on the other side of it, and the money went into the
    // budget twice under a reply that said nothing about it.
    const refused = new Set<number>();
    const allowed: Array<{ index: number; found: string }> = [];

    /** A fault with no way round it, whatever the caller passed. */
    const refuse = (index: number, reason: string) => {
      if (refused.has(index)) return;
      refused.add(index);
      problems.push({ index, reason });
    };

    /**
     * A row that looks like a duplicate, which is a guess and can be
     * overruled.
     *
     * The finding and the advice are separate because only one of them
     * belongs in each answer. A row that was refused is told how to proceed;
     * a row that came in under `allow_duplicate` has already proceeded, and
     * "pass allow_duplicate" would be advice to someone who did.
     *
     * The checks run either way now. Skipping them for an allowed row would
     * save the two queries the last one makes and lose the only chance to say
     * what they found, so a batch with duplicates in it would read exactly
     * like one without (#175).
     */
    const complain = (index: number, found: string, advice: string) => {
      // Every finding, for a row that is going in anyway. One per row is a
      // rule about what to fix, and there is nothing to fix here.
      if (byIndexAllowed(index)) {
        allowed.push({ index, found });
        return;
      }
      if (refused.has(index)) return;
      refused.add(index);
      problems.push({ index, reason: `${found} ${advice}` });
    };
    const allowedRows = new Set(resolved.filter((row) => row.allowDuplicate).map((r) => r.index));
    function byIndexAllowed(index: number): boolean {
      return allowedRows.has(index);
    }

    // Identity, so no escape: `allow_duplicate` does not reach these.
    const seenIds = new Map<string, number>();
    for (const row of resolved) {
      if (!row.importedId) continue;
      const key = `${row.accountId}|${row.importedId}`;
      const first = seenIds.get(key);
      if (first !== undefined) {
        refuse(
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
          refuse(
            row.index,
            `imported_id "${row.importedId}" is already in ${row.accountName}, so this row ` +
              `has been recorded before. If your bank reused the id and this is a different ` +
              `movement, send it without an imported_id, or with one of your own.`,
          );
        }
      }
    }

    // The approximate checks, which run whatever the caller passed. Skipping
    // them for a row that is allowed to duplicate would save two queries on
    // the last one and lose the only chance to say what they found, so a
    // batch with accepted duplicates in it would read exactly like one with
    // none (#175).
    // Two rows in the same call that are the same movement. The existing
    // duplicate check asks about rows already in the budget (#88), and two
    // identical rows arriving together is a case it has never seen, because
    // until now they could not arrive together. Measured: the engine writes
    // both.
    //
    // Both halves of one movement, first. A pay-off read from two statements
    // arrives as `{Bank, -800, payee "Card"}` and `{Card, +800, payee
    // "Bank"}`, and each of those asks for both legs, so writing both put
    // the payment in twice. The check below could not see it: the two rows
    // name different accounts.
    const pairs = new Map<string, number>();
    for (const row of resolved) {
      if (!row.transfer) continue;
      const key = transferPairKey({
        sourceAccountId: row.accountId,
        targetAccountId: row.transfer.targetId,
        amountCents: row.amountCents,
        date: row.date,
      });
      const first = pairs.get(key);
      if (first !== undefined) {
        complain(
          row.index,
          `is row ${first + 1} again: the same movement between the same two accounts on ` +
            `the same day, written from the other account. One of them records both sides, ` +
            `so only one is needed.`,
          `If these really are two separate movements, set allow_duplicate on row ${row.index + 1}.`,
        );
      } else {
        pairs.set(key, row.index);
      }
    }

    const seen = new Map<string, number>();
    for (const row of resolved) {
      const key = `${row.accountId}|${row.date}|${row.amountCents}`;
      const first = seen.get(key);
      if (first !== undefined) {
        complain(
          row.index,
          `repeats row ${first + 1}: same account, date and amount.`,
          `If both really happened, set allow_duplicate on row ${row.index + 1}.`,
        );
      } else {
        seen.set(key, row.index);
      }
    }

    // Both sides of one movement, where one of them is an ordinary row.
    //
    // A card statement lists the payment as something like "PAYMENT
    // RECEIVED", not as an account name, so a month read off both statements
    // arrives as a transfer from the current account and an ordinary credit
    // on the card. The transfer writes both sides, so the ordinary row is
    // the same money a second time. The pair key above cannot see it: that
    // one compares two transfers.
    //
    // The ordinary row is the one refused, not the transfer: the transfer
    // records both sides, so it is the row that can go.
    // Rows already reported are left out: one of them taking a transfer
    // with it is how a row that does collide ends up counted among the ones
    // that were fine. Measured on a batch holding the same credit twice.
    const byIndex = new Map(resolved.map((row) => [row.index, row]));
    for (const pair of pairCounterparts(
      resolved.map((row) => ({
        index: row.index,
        accountId: row.accountId,
        amountCents: row.amountCents,
        date: row.date,
        transferTargetId: row.transfer?.targetId,
      })),
      COUNTERPART_WINDOW_DAYS,
      refused,
    )) {
      const transfer = byIndex.get(pair.transfer)!;
      const ordinary = byIndex.get(pair.ordinary)!;
      complain(
        ordinary.index,
        `is the other side of the transfer in row ${transfer.index + 1}: that row moves ` +
          `${formatMoney(Math.abs(transfer.amountCents))} on ${transfer.date} and writes ` +
          `the matching row in ${ordinary.accountName} itself, and this one records the ` +
          `same money on ${ordinary.date}. Keeping both puts it in twice.`,
        `Drop this row, or set allow_duplicate on row ${ordinary.index + 1} if they ` +
          `really are two movements.`,
      );
    }

    for (const row of resolved) {
      // Nothing is written when any row is refused, so asking the budget
      // about one that already has a problem buys an answer nobody reads.
      if (refused.has(row.index)) continue;
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
            `${formatMoney(row.amountCents)}.`,
          `If this is a second one, set allow_duplicate on row ${row.index + 1}.`,
        );
        continue;
      }

      // And the row the transfer is about to put in the other account, which
      // nothing used to look at. A card payment already imported from the
      // bank is an ordinary row there; the transfer's own leg lands on top of
      // it and the account shows the money arriving twice.
      if (!row.transfer) continue;
      const counterpart = await findUnlinkedCounterpart(
        row.transfer.targetId,
        row.date,
        row.amountCents,
        { alreadyPulled: true },
      );
      if (counterpart.length > 0) {
        // The dates, because they are the part that is not obvious: the
        // match may be a day either side, and saying only "already has a
        // transaction" sends someone to look on the wrong day.
        const when = counterpart.map((c) => c.date).join(', ');
        complain(
          row.index,
          `${row.transfer.targetName} already has a transaction for ` +
            `${formatMoney(-row.amountCents)} on ${when}, which is not part of a transfer. ` +
            `This row is dated ${row.date}, and the two sides of one movement are often a ` +
            `day apart. The transfer would put a second row there.`,
          `If that is this same movement, already imported, drop this row; if it is a ` +
            `different one, set allow_duplicate on row ${row.index + 1}.`,
        );
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

    return await writeBatch(resolved, rows.length, accounts, allowed);
  });
}

async function writeBatch(
  resolved: ResolvedRow[],
  total: number,
  accounts: Array<{ id: string; name: string; offbudget?: boolean }>,
  allowed: Array<{ index: number; found: string }>,
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

  // Counted for every account the batch can touch, which is not only the ones
  // it writes to: a transfer puts a row in the other account as well, and
  // leaving those out of the table hid half of what the call did. It hid most
  // of it when the batch stopped part way, where the counts are the only
  // record of what landed.
  const names = new Map<string, string>();
  for (const [accountId, group] of byAccount) names.set(accountId, group[0].accountName);
  for (const row of resolved) {
    if (row.transfer?.payeeId) names.set(row.transfer.targetId, row.transfer.targetName);
  }

  const before = new Map<string, number>();
  for (const accountId of names.keys()) {
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

  // One read for the whole batch, by the ids the rows were written with. It
  // pays for two things at once: the learned mapping can still have
  // overridden an explicit category on the way in and has to be corrected,
  // and the rules can have changed the amount, the date, the payee, the notes
  // or the cleared flag, which the reply used to describe from the request
  // (#184).
  //
  // It answers null rather than throwing when the budget cannot be read. The
  // query that was here threw, and by this point the rows are already in the
  // budget: a batch that landed would have been reported as an error, which
  // is the one answer that invites resending it.
  const saved = await findSavedRowsByMarker(written.map((row) => row.marker));

  // The parts of whichever rows a rule split, in one more query and only when
  // there is a split in the batch. A split parent carries neither payee nor
  // category: measured, the parts carry both.
  const splitParents = [...(saved?.values() ?? [])].filter((row) => row.isParent);
  const parts = splitParents.length > 0 ? ((await findSavedParts(splitParents.map((r) => r.id))) ?? []) : [];
  const partsByParent = new Map<string, SavedRow[]>();
  for (const part of parts) {
    if (!part.parentId) continue;
    const group = partsByParent.get(part.parentId);
    if (group) group.push(part);
    else partsByParent.set(part.parentId, [part]);
  }

  for (const row of written) {
    if (!row.categoryId) continue;
    const actual = saved?.get(row.marker);
    if (!actual) continue;
    // Nothing to force on a split, and nothing to warn about: measured
    // against the engine, the parts carry the category that was asked for,
    // and a rule that sets its own on a part wins there. The warning this
    // printed said the category had not been applied, which is false.
    if (actual.isParent) continue;
    // And nothing to force on a transfer between two accounts on the same
    // side of the budget. `clearCategory` takes the category off both rows
    // and runs again on every update, so this would buy one more clear; the
    // paragraph in the reply already says it was not kept.
    //
    // The side is read from the account the row reached, not from the one it
    // was sent to: a rule can redirect it, and the skip then missed.
    const movements = transferLegs({
      saved: actual,
      parts: partsByParent.get(actual.id) ?? [],
      accounts,
      sourceOffBudget: row.transfer?.sourceOffBudget ?? false,
      fallbackName: row.transfer?.targetName,
      fallbackOffBudget: row.transfer?.targetOffBudget,
    });
    if (
      row.transfer &&
      movements.some((leg) => clearsCategory(leg, row.transfer!.sourceOffBudget))
    ) {
      continue;
    }
    if (actual.category !== row.categoryId) {
      await updatePreservingChildAmount(row.marker, {
        category: row.categoryId,
        amount: actual.amount,
      });
    }
  }

  await syncNow();

  const lines: string[] = [];
  const counts: string[] = [];
  for (const [accountId, name] of names) {
    const rows = await api.getTransactions(
      accountId,
      '1900-01-01',
      '2999-12-31',
    );
    const was = before.get(accountId) ?? 0;
    // An account that only ever received counterparts, and received none
    // because the batch stopped first, has nothing to report: listing it
    // unchanged would read as though something had been attempted there.
    if (was === rows.length && !byAccount.has(accountId)) continue;
    counts.push(`  ${name}: ${was} -> ${rows.length}`);
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
  lines.push(...describeAllowed(allowed, written));
  lines.push(...describeTransfers(written, saved, partsByParent, accounts));
  lines.push(...describeRuleChanges(written, saved, partsByParent));
  if (!saved && written.length > 0) {
    // Said in the reply, not only on stderr, which the caller never sees. The
    // counts above are read from the budget and stand; everything said about
    // the individual rows would be what was asked for.
    lines.push(
      '',
      'The budget could not be read back just now, so nothing above describes what your rules ' +
        'did to these rows, and a category asked for may not have been enforced.',
    );
  }
  return lines;
}

/**
 * Name the rows that turned into transfers, at the end, once.
 *
 * The caller wrote a payee and got something else, and in #137 the person did
 * not find out until they went looking for spending they thought they had
 * recorded. Saying it per row would repeat the same paragraph up to twenty
 * times in one reply, so the rows are listed and the explanation follows once
 * per kind of effect that actually occurred.
 *
 * Each row's movements are read from the budget, as a list: a rule can split
 * a row and send the parts to different accounts, so one row can move more
 * than once and the parts can land on opposite sides of the budget. A row
 * that asked to be a transfer and made no movement is listed apart (#184).
 */
function describeTransfers(
  written: ResolvedRow[],
  saved: Map<string, SavedRow> | null,
  partsByParent: Map<string, SavedRow[]>,
  accounts: Array<{ id: string; name: string; offbudget?: boolean }>,
): string[] {
  const asked = written.filter((row) => row.transfer?.payeeId);
  if (asked.length === 0) return [];

  const entries = asked.map((row) => {
    const found = saved?.get(row.marker);
    const legs = found
      ? transferLegs({
          saved: found,
          parts: partsByParent.get(found.id) ?? [],
          accounts,
          sourceOffBudget: row.transfer!.sourceOffBudget,
          fallbackName: row.transfer!.targetName,
          fallbackOffBudget: row.transfer!.targetOffBudget,
        })
      : // With no row to read, the reply describes what was asked for, as it
        // did before.
        [
          requestedLeg({
            accountId: row.transfer!.targetId,
            accountName: row.transfer!.targetName,
            offBudget: row.transfer!.targetOffBudget,
            amountCents: row.amountCents,
            sourceOffBudget: row.transfer!.sourceOffBudget,
          }),
        ];
    return { row, legs };
  });

  const made = entries.filter((entry) => entry.legs.length > 0);
  const missed = entries.filter((entry) => entry.legs.length === 0);

  const lines: string[] = [];

  if (made.length > 0) {
    const movements = made.flatMap((entry) =>
      entry.legs.map((leg, index) => ({
        label:
          entry.legs.length === 1
            ? `row ${entry.row.index + 1}`
            : `row ${entry.row.index + 1} part ${index + 1}`,
        from: entry.row.accountName,
        leg,
        // A rule can point the row at another account's transfer payee, and
        // the engine links it there. The route names the account it reached;
        // this says the caller did not choose it.
        note:
          leg.row && leg.row.payee !== entry.row.transfer!.payeeId
            ? `(a rule sent it to ${leg.accountName}, not ${entry.row.transfer!.targetName})`
            : undefined,
      })),
    );
    const count = made.length;
    // The older wording whenever every row moved once and went where it was
    // sent, which is every batch nothing happened to: "the account each one
    // reached" is there for the rows that moved twice or landed somewhere
    // else, and it should not change a reply that has neither.
    const plain = movements.length === made.length && movements.every((m) => !m.note);
    lines.push(
      '',
      `${count} of them named one of your accounts, so ${count === 1 ? 'it was' : 'they were'} ` +
        `recorded as ${count === 1 ? 'a transfer' : 'transfers'} and a matching row was created ` +
        (plain ? `in the other account:` : `in the account each one reached:`),
      '',
      ...legTable(movements),
      ...effectParagraphs(movements.map((m) => m.leg)),
    );

    // Only when there is a category to talk about, and the two cases are not
    // the same thing. On a row that crosses the edge of the budget the
    // category is kept where it was asked for; between two accounts on the
    // same side Actual removes it, which #137 recorded the other way round
    // because it read the row before the engine had finished with it.
    const crossing = made.filter(
      (entry) =>
        entry.row.categoryId &&
        entry.legs.some((leg) => leg.effect === 'incoming' || leg.effect === 'outgoing'),
    );
    // Split by where the category actually landed, rather than left as a
    // condition for the reader to apply. "Counts only if that row is in your
    // budget" is true and makes someone work out which case they are in, and
    // the whole point of saying anything is that they should not have to.
    const counted = crossing.filter((entry) => !entry.row.transfer!.sourceOffBudget);
    const notCounted = crossing.filter((entry) => entry.row.transfer!.sourceOffBudget);
    if (counted.length > 0) {
      lines.push(
        '',
        `The category on ${counted.length === 1 ? 'that row counts' : 'those rows counts'} where ` +
          'you asked for it, since that side is in your budget.',
      );
    }
    if (notCounted.length > 0) {
      const names = [...new Set(notCounted.map((entry) => entry.row.accountName))].join(', ');
      lines.push(
        '',
        `The category stayed on the ${names} row, but ${names} is off budget, so it does not ` +
          'count anywhere. To make this count, put a category on the row in the other account.',
      );
    }

    // Both accounts on the same side of the budget, which is what
    // `clearCategory` goes by. Read from the engine's rule rather than from
    // the row, because it runs after the row can first be read.
    const sameSide = made.filter(
      (entry) =>
        entry.row.categoryId &&
        entry.legs.some((leg) => clearsCategory(leg, entry.row.transfer!.sourceOffBudget)),
    );
    if (sameSide.length > 0) {
      lines.push(
        '',
        `The category on ${sameSide.length === 1 ? 'the row that moved' : 'the rows that moved'} ` +
          `between two accounts on the same side of your budget was not kept: Actual discards ` +
          `it there, since nothing could count it.`,
      );
    }
  }

  if (missed.length > 0) {
    const count = missed.length;
    // No route on these. An arrow between two accounts says the money went
    // from one to the other, and the whole point of this table is that it did
    // not: the row sits in its own account and nothing was written anywhere
    // else.
    const accountWidth = Math.max(...missed.map((e) => e.row.accountName.length));
    const amountWidth = Math.max(
      ...missed.map((e) => formatMoney(Math.abs(e.row.amountCents)).length),
    );
    lines.push(
      '',
      `${count} of them named one of your accounts but ${count === 1 ? 'was' : 'were'} not recorded as ` +
        `${count === 1 ? 'a transfer' : 'transfers'}. The saved ${count === 1 ? 'row is' : 'rows are'} ` +
        `not linked to one, so nothing was created in the other account and ` +
        `${count === 1 ? 'it stayed an ordinary transaction' : 'they stayed ordinary transactions'}:`,
      '',
      ...missed.map(
        (e) =>
          `  row ${e.row.index + 1}  ${e.row.accountName.padEnd(accountWidth)}  ` +
          `${formatMoney(Math.abs(e.row.amountCents)).padStart(amountWidth)}  ` +
          `asked for ${e.row.transfer!.targetName}`,
      ),
    );
  }

  return lines;
}

/**
 * The rows that came in because somebody said they could.
 *
 * `allow_duplicate` used to switch the approximate checks off, so a batch
 * sent with it read exactly like one with nothing wrong in it, and afterwards
 * there was no telling the two apart. The checks run either way now and this
 * says what they found, which is the whole of what the flag overruled (#175).
 *
 * Only the rows a check actually fired on. A flag on a row nothing was found
 * about did nothing, and listing it would pad the reply with rows that have
 * no finding to show.
 */
function describeAllowed(
  allowed: Array<{ index: number; found: string }>,
  written: ResolvedRow[],
): string[] {
  const byIndex = new Map(written.map((row) => [row.index, row]));
  const shown = allowed.filter((entry) => byIndex.has(entry.index));
  if (shown.length === 0) return [];

  const one = shown.length === 1;
  return [
    '',
    `${shown.length} ${one ? 'row' : 'rows'} went in with allow_duplicate, so what the ` +
      `checks found about ${one ? 'it' : 'them'} was not acted on:`,
    '',
    ...shown.flatMap((entry) => {
      const row = byIndex.get(entry.index)!;
      return [
        `  row ${entry.index + 1}  ${row.accountName}  ${formatMoney(row.amountCents)}  ${row.date}`,
        `      ${entry.found}`,
      ];
    }),
  ];
}

/**
 * What the rules changed, row by row, once at the end.
 *
 * The batch says how many rows went in and what each transfer did, and
 * nothing else about the individual rows, so until now a rule could rewrite
 * an amount and the reply would not be wrong, only silent. Silent is its own
 * problem: the figure in the budget is not the figure that was sent, and the
 * only way to find out was to read the account afterwards.
 *
 * Only the rows a rule touched are listed, so a batch nothing happened to
 * reads exactly as it did before.
 */
function describeRuleChanges(
  written: ResolvedRow[],
  saved: Map<string, SavedRow> | null,
  partsByParent: Map<string, SavedRow[]>,
): string[] {
  if (!saved) return [];

  const changed: Array<{ index: number; what: string }> = [];
  for (const row of written) {
    const found = saved.get(row.marker);
    if (!found) continue;
    // A split's payee lives on its parts, so the parent is the wrong row to
    // compare: reading it reported every split as having kept the payee that
    // was asked for, whatever a rule had put on the parts.
    const actual = rowForComparison(found, partsByParent.get(found.id) ?? []);
    const asked: AskedRow = {
      date: row.date,
      amountCents: row.amountCents,
      payee: row.payee,
      transferPayeeId: row.transfer?.payeeId,
      notes: row.notes,
      cleared: row.cleared,
    };
    const changes = listChanges(changesMadeByRules(asked, actual));
    if (changes.length === 0) continue;
    changed.push({
      index: row.index,
      what: changes.map(describeChange).join(', '),
    });
  }

  if (changed.length === 0) return [];

  return [
    '',
    `Your rules changed ${changed.length} of these rows while ${changed.length === 1 ? 'it was' : 'they were'} ` +
      `being written. The budget holds what is on the right of each line, not what was sent:`,
    '',
    ...changed.map((e) => `  row ${e.index + 1}  ${e.what}`),
  ];
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
            allow_duplicate: z
              .boolean()
              .optional()
              .describe(
                'Let this one row through the checks that compare account, date and amount, ' +
                  'for the row you know really is a second movement. Every other row keeps ' +
                  'its checks. It does not reach the imported_id checks, which are identity ' +
                  'rather than a guess, and the reply says what the checks found about it.',
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
          'Create the rows even though some repeat each other or match transactions already ' +
            'in the budget. Without this, such a batch is reported and nothing is written. ' +
            'The reply says which rows the checks found something about. To let one row ' +
            'through and keep the checks on the rest, put allow_duplicate on that row instead.',
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
