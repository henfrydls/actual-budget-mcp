import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import * as api from '@actual-app/api';
import { ensureConnection } from '../../connection.js';
import { amountToCents, formatMoney } from '../../utils/money.js';
import { resolveDate } from '../../utils/dates.js';
import { resolveAccountId, resolveCategoryId } from '../../utils/resolvers.js';
import { describeError } from '../../utils/errors.js';
import { mayHaveBeenApplied, verifyFailedWrite, WriteReportedError } from '../../utils/write-outcome.js';
import { newWriteMarker, findByMarker, corroborateAbsence } from '../../utils/write-marker.js';
import {
  findPossibleDuplicates,
  describePossibleDuplicates,
} from '../../utils/duplicate-check.js';
import { updatePreservingChildAmount } from '../../utils/transactions.js';
import { queueTransactionWrite } from '../../utils/transaction-writes.js';

export interface CreateTransactionInput {
  /** Go ahead even though a transaction with the same account, date and amount exists. */
  allow_duplicate?: boolean;
  /**
   * What to tell the caller instead of the default "pass allow_duplicate".
   * Internal: set by tools that create through this one and whose safe way
   * forward is different. Not part of the tool's own schema.
   */
  duplicateAdvice?: string[];
  account: string;
  amount: number;
  payee?: string;
  category?: string;
  date?: string;
  notes?: string;
  cleared?: boolean;
}

/**
 * Create a single transaction, guaranteeing that an explicit `category` wins.
 *
 * The Actual SDK applies the learned payee→category mapping on add via its
 * internal rules engine. This happens regardless of `learnCategories: false`
 * (that flag only disables *learning* new mappings, not *applying* existing
 * ones), so the caller's explicit category can be silently overridden (#26).
 *
 * `api.addTransactions` resolves to the literal `'ok'` (never the new ids), so
 * the created row cannot be read from its return value. It is given an id of
 * our own before the write, looked up by that id afterwards, and corrected with
 * `updateTransaction` (which does not re-run the learning override, so the
 * correction sticks). This used to diff the account's transactions for the date
 * instead, which could reach another process's row.
 *
 * Returns the human-readable confirmation lines.
 */
export async function createTransaction(input: CreateTransactionInput): Promise<string[]> {
  await ensureConnection();

  const accountId = await resolveAccountId(input.account);
  const txnDate = resolveDate(input.date);
  const amountCents = amountToCents(input.amount);
  const accounts = await api.getAccounts();

  // A payee that names another account is a transfer: route it through that
  // account's transfer payee with runTransfers so both sides are linked (#24).
  // Writing the other account's name is how someone asks for a transfer, and
  // before #24 only one side of it was created.
  //
  // Unless a category was asked for **and the other account is on budget**.
  // Between two on-budget accounts the money has not left the budget, so there
  // is nothing to categorise and Actual drops the category: naming one says
  // the opposite of a transfer. That is #137 -- someone whose prepaid card is
  // topped up at a station called "Fuel Station" has an account by that name
  // too, and `payee: "Fuel Station", category: "Fuel"` moved money from the
  // card to the prepaid account, dropped the category, and had to be deleted
  // by hand.
  //
  // A transfer to an **off-budget** account is the opposite case: the money
  // leaves the budget, so it is spending, and a category is exactly what it
  // wants. Measured in the engine -- the category stays on the source row and
  // the counterpart row carries none:
  //
  //   Card (on budget)       amount -10000  category set  transfer_id set
  //   Investments (off)      amount  10000  category null transfer_id set
  //
  // A first version of this fix applied the rule to both and broke that: a
  // category plus an off-budget account produced a plain expense with no
  // counterpart, so the asset stopped growing and nothing said so. That is a
  // real pattern here -- a category for the contribution and an off-budget
  // account holding the asset.
  let transferPayeeId: string | undefined;
  let transferTargetName: string | undefined;
  let transferTargetOffBudget = false;
  if (input.payee) {
    const lower = input.payee.toLowerCase();
    // `!a.closed` is belt and braces: measured, `getAccounts()` leaves closed
    // accounts out of the list altogether rather than returning them with the
    // flag set, so a closed account's name falls through and becomes an
    // ordinary payee either way. Which is the right answer -- there is nothing
    // to transfer into -- and the reason removing this line changes no test.
    const target = accounts.find(
      (a) => !a.closed && (a.id === input.payee || a.name.toLowerCase() === lower),
    );
    if (target) {
      if (target.id === accountId) {
        throw new Error('Cannot transfer to the same account.');
      }
      const offBudget = Boolean((target as { offbudget?: boolean }).offbudget);
      // The rule only applies between on-budget accounts.
      if (!input.category || offBudget) {
        const payees = await api.getPayees();
        const transferPayee = payees.find((p) => p.transfer_acct === target.id);
        if (!transferPayee) {
          throw new Error(`No transfer payee found for account "${target.name}".`);
        }
        transferPayeeId = transferPayee.id;
        transferTargetName = target.name;
        transferTargetOffBudget = offBudget;
      }
    }
  }

  // Resolved whichever this turns out to be. A transfer to an off-budget
  // account keeps it, which is what the engine does; between on-budget
  // accounts the branch above means there is no category to keep.
  const categoryId = input.category ? await resolveCategoryId(input.category) : undefined;

  const transaction: Record<string, unknown> = {
    date: txnDate,
    amount: amountCents,
    cleared: input.cleared ?? false,
  };
  if (transferPayeeId) {
    transaction.payee = transferPayeeId;
  } else if (input.payee) {
    transaction.payee_name = input.payee;
  }
  if (categoryId) transaction.category = categoryId;
  if (input.notes) transaction.notes = input.notes;

  const acctNameForCheck = accounts.find((a) => a.id === accountId)?.name || accountId;

  // Asked before writing, and asked with the same values the write will use:
  // `accountId`, `txnDate` and `amountCents` are the ones assembled above, not
  // a second reading of the input. A check that asks a different question from
  // the write it guards lies at the edges, which is the shape that produced two
  // regressions in #96.
  if (!input.allow_duplicate) {
    const existing = await findPossibleDuplicates(accountId, txnDate, amountCents);
    if (existing.length > 0) {
      // Nothing is created. A warning that warns after creating leaves the
      // duplicate behind, which is the harm this exists to prevent; the caller
      // decides first, the way the destructive tools already ask.
      //
      // Unlike those, this is not returned with `isError`. Theirs is set so a
      // repeated call cannot destroy anything by accident; here a repeated
      // call creates nothing at all, and flagging an error would push an agent
      // towards the retry that duplicates.
      return describePossibleDuplicates(existing, acctNameForCheck, input.duplicateAdvice);
    }
  }

  // Label the write before sending it. This is what identifies the row
  // afterwards, instead of a snapshot and a date window (#93): rules can
  // rewrite the amount and the date, so nothing else on the row is both stable
  // and ours.
  const marker = newWriteMarker();
  transaction.id = marker;

  const acctName = accounts.find((a) => a.id === accountId)?.name || accountId;

  try {
    await api.addTransactions(accountId, [transaction as any], {
      learnCategories: false,
      runTransfers: !!transferPayeeId,
    });

    // Force the explicit category on the transaction we just created, found by
    // its marker rather than by "new rows around this date". The old diff could
    // reach another process's row and give it this transaction's category:
    // silent, on the success path, and invisible in a reconciliation.
    if (categoryId) {
      const ours = await findByMarker(marker);
      // A rule can turn what we sent into a split. Actual ignores the category
      // on a split parent, so setting it would do nothing and reporting
      // `Category: X` would be a lie. Before the lookup could see parents at
      // all this fell through to the warning below by accident; now it has to
      // be said on purpose.
      const becameSplit = (ours ?? []).some(
        (row) => (row as { is_parent?: boolean }).is_parent === true,
      );
      if (becameSplit) {
        console.error(
          `[create_transaction] warning: a rule turned the new transaction on ${txnDate} into a split, and a split's category lives on its parts, so the category you asked for was not applied.`,
        );
      } else if (ours && ours.length > 0) {
        for (const row of ours) {
          if (row.category !== categoryId) {
            // #44: pass the amount we already have, so the update can never
            // reset it.
            await updatePreservingChildAmount(row.id, {
              category: categoryId,
              amount: row.amount,
            });
          }
        }
      } else {
        // Warn on stderr — never stdout, which is the MCP protocol channel.
        console.error(
          `[create_transaction] warning: could not find the new transaction on ${txnDate} to enforce its category; it may have been overridden by a learned mapping.`,
        );
      }
    }

    await api.sync();
  } catch (error) {
    if (!mayHaveBeenApplied(error)) throw error;

    // Actual can apply a write and fail afterwards, so "Error" does not mean
    // "it did not happen". Go and look before saying anything.
    const { verdict, message } = await verifyFailedWrite(error, {
      action: 'The transaction',
      whereToLook: `${acctName} on ${txnDate}`,
      probe: {
            marker,
            find: findByMarker,
            corroborate: () => corroborateAbsence(accountId, marker),
          },
    });
    throw new WriteReportedError(message, verdict);
  }

  const acct = accounts.find((a) => a.id === accountId);

  const lines = [
    transferPayeeId ? 'Transfer created:' : 'Transaction created:',
    `  Account:  ${acct?.name || accountId}`,
    `  Date:     ${txnDate}`,
    `  Amount:   ${formatMoney(amountCents)}`,
  ];
  if (transferPayeeId) {
    // Direction from the sign, not from the argument. A positive amount is
    // money arriving, so the other account is where it came from; calling that
    // a transfer "to" them says the opposite of what the engine just did.
    lines.push(
      amountCents >= 0
        ? `  Transfer from: ${transferTargetName}`
        : `  Transfer to: ${transferTargetName}`,
    );
  } else if (input.payee) {
    lines.push(`  Payee:    ${input.payee}`);
  }
  if (input.category) lines.push(`  Category: ${input.category}`);
  if (transferPayeeId) {
    // Said out loud, because the caller asked for a payee and got a transfer,
    // and in #137 the person did not find out until they went looking for the
    // spending they thought they had recorded.
    //
    // By name, never by id: the payee can be given either way, and echoing a
    // uuid back as "the name of an account" tells the reader nothing.
    const incoming = amountCents >= 0;
    const direction = incoming ? 'from' : 'to';
    lines.push(
      '',
      `${transferTargetName} is one of your accounts, so this was recorded as a transfer ` +
        `${direction} it.`,
      `A matching row was created there.`,
    );
    if (transferTargetOffBudget) {
      // Off budget is not "between your accounts": the money left the budget,
      // or came into it, which is the whole point of the account being
      // off budget.
      lines.push(
        `${transferTargetName} is off budget, so this money ` +
          (incoming ? 'came into your budget.' : 'left your budget.') +
          (input.category ? '' : ' Give it a category to say where it counts.'),
      );
    } else {
      lines.push(
        'The money moved between accounts inside your budget, so it is not spending.',
        'To record a purchase instead, give it a category, or use a payee that is not an',
        'account name.',
      );
    }
  }
  if (input.notes) lines.push(`  Notes:    ${input.notes}`);

  return lines;
}

export function registerCreateTransaction(server: McpServer): void {
  server.tool(
    'create_transaction',
    'Add a new transaction to an account. Use negative amounts for expenses, positive for income. ' +
      'If a transaction with the same account, date and amount already exists, this creates nothing ' +
      'and returns the existing one instead; pass allow_duplicate to go ahead anyway.',
    {
      account: z.string().describe('Account name or ID'),
      amount: z
        .number()
        .describe(
          'Amount (negative for expenses, positive for income). Use human amounts like -150.50, not cents.',
        ),
      payee: z
        .string()
        .optional()
        .describe(
          'Payee name, or the name of one of your accounts to make a transfer. Naming an ' +
            'account moves money between accounts and creates the matching row there. ' +
            'Between two on-budget accounts, giving a category instead records an ordinary ' +
            'purchase, for when a shop happens to share an account name. To an off-budget ' +
            'account it stays a transfer and keeps the category, because the money leaves ' +
            'the budget.',
        ),
      category: z
        .string()
        .optional()
        .describe(
          'Category name or ID. Giving one stops a payee that names an on-budget account ' +
            'from becoming a transfer. An empty string counts as no category.',
        ),
      date: z
        .string()
        .optional()
        .describe(
          'Transaction date (YYYY-MM-DD or "today", "yesterday"). Defaults to today.',
        ),
      notes: z.string().optional().describe('Transaction notes'),
      cleared: z
        .boolean()
        .optional()
        .default(false)
        .describe('Whether the transaction is cleared'),
      allow_duplicate: z
        .boolean()
        .optional()
        .describe(
          'Create it even though a transaction with the same account, date and amount already exists. Without this, such a call returns the existing one and creates nothing.',
        ),
    },
    { title: 'Add transaction', readOnlyHint: false },
    async (input) =>
      // Serialised with every other transaction write, so two calls
      // sent without awaiting the first cannot read each other half
      // done (#111).
      queueTransactionWrite(async () => {
      try {
        const lines = await createTransaction(input);
        return { content: [{ type: 'text', text: lines.join('\n') }] };
      } catch (error) {
        // A write that landed is not reported as an error, however the
        // operation ended: an agent reading "Error:" has every reason to try
        // again, and trying again is what duplicates. That covers a duplicate
        // too — it landed twice, so repeating it is the last thing to do.
        if (error instanceof WriteReportedError && (error.verdict === 'applied' || error.verdict === 'duplicated')) {
          return { content: [{ type: 'text', text: error.message }] };
        }
        const message = describeError(error);
        return {
          content: [{ type: 'text', text: `Error: ${message}` }],
          isError: true,
        };
      }
      },
    ),
  );
}
