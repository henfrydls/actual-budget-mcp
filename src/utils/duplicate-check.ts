import * as api from '@actual-app/api';
import { transactionsQuery } from './transaction-query.js';
import { formatMoney } from './money.js';

/**
 * Look for a transaction that already says what this one is about to say.
 *
 * Two agents working against one budget is the normal case here, and neither
 * can see what the other just wrote. Recording the same payment twice was
 * reported with no way to tell it had happened except syncing and reading by
 * hand (#88). It pairs with #79: an error that lies about whether a write
 * landed, and no duplicate detection, is the combination that quietly corrupts
 * a budget.
 *
 * Same account, same date, same amount. Deliberately not the payee or the
 * notes: a rule can rewrite both between asking and landing, and two entries of
 * one payment often differ in exactly those fields — one typed by hand, one
 * imported. Matching on them would miss the case this exists for.
 *
 * ## What it cannot catch
 *
 * The same argument that rules out payee and notes applies, in a weaker form,
 * to the three fields it does use. The lookup asks with the values the caller
 * gave; a rule that rewrites the amount or the date rewrites them *after* the
 * row is stored, so the stored row no longer matches what was asked and the
 * duplicate goes through. There is no way around it from this side — the values
 * after the rule are not knowable until something has been written — so it is
 * written down rather than papered over. Renaming rules, which are the common
 * kind, are unaffected.
 */
export interface ExistingTransaction {
  id: string;
  date: string;
  amount: number;
  payeeName?: string;
  notes?: string | null;
  /** One leg of a transfer, which reads as ordinary income or spending unless said. */
  isTransfer: boolean;
}

/**
 * Pull what other processes have written, then read.
 *
 * Every other `api.sync()` in this server runs *after* a write, to push. This
 * one runs before a read, to pull, and it is the difference between a check
 * that works and one that only looks like it does: #88 is about two agents
 * against one budget, and neither sees the other's rows until it syncs. Without
 * this the lookup would interrogate a local copy that, by construction, cannot
 * hold the row it is looking for — the motivating case would be the one case it
 * could never catch.
 *
 * **It has to be awaited.** Starting the pull and reading anyway leaves exactly
 * the behaviour this replaced, while looking like the fix: a test that only
 * checks which call was made first cannot tell the two apart, so the one here
 * checks that the pull has *finished*.
 *
 * A sync that fails must not stop anyone recording a transaction, so it is
 * reported on stderr and the read happens regardless. The result is weaker, not
 * wrong: it still sees everything this process wrote. The caller is not left
 * guessing either, because a write's own sync is still to come and reports its
 * own failure.
 *
 * The prefix names the package rather than a tool: this is shared, and #98 will
 * give it more callers than `create_transaction`.
 */
export async function pullBeforeReading(what: string): Promise<void> {
  try {
    await api.sync();
  } catch (error) {
    // stderr: stdout carries JSON-RPC.
    console.error(
      `[actual-budget-mcp] warning: could not sync before ${what}, so it saw only ` +
        "this machine's copy of the budget and may have missed what another client " +
        'wrote. Reason: ' +
        String((error as Error)?.message ?? error),
    );
  }
}

export async function findPossibleDuplicates(
  accountId: string,
  date: string,
  amountCents: number,
): Promise<ExistingTransaction[]> {
  await pullBeforeReading('checking whether this transaction already exists');

  const result = await api.runQuery(
    transactionsQuery('all')
      // `splits: 'all'` and not the default. AQL's default adds
      // `WHERE is_parent = 0`, so a duplicated split parent would be invisible
      // here, which is the failure #91 spent four rounds on.
      //
      // `all` also returns the children, and they must be excluded. A child is
      // not a transaction anyone can record twice: it is an internal share of
      // its parent, it inherits the parent's payee, and it carries no mark of
      // being part of anything. Reporting one rejects a legitimate purchase and
      // names a row the user cannot find — a -40 chemist's bill refused for
      // matching the -40 share of a -70 supermarket split, under the name
      // "Super". The parent is still matched, at the full amount, which is the
      // row a duplicate would actually collide with.
      .filter({ account: accountId, date, amount: amountCents, is_child: false })
      .select(['id', 'date', 'amount', 'notes', 'payee', 'transfer_id']),
  );
  const rows = (result as { data?: Array<Record<string, unknown>> } | undefined)?.data;
  if (!Array.isArray(rows) || rows.length === 0) return [];

  // Payee ids mean nothing to a reader, and the whole point is to name the
  // transaction well enough to recognise it.
  const payees = await api.getPayees();
  const names = new Map(payees.map((p) => [p.id, p.name]));

  return rows.map((row) => ({
    id: String(row.id),
    date: String(row.date),
    amount: Number(row.amount),
    payeeName: row.payee ? names.get(String(row.payee)) : undefined,
    notes: (row.notes as string | null) ?? null,
    isTransfer: row.transfer_id != null,
  }));
}

/**
 * Describe what was found, and how to go ahead anyway.
 *
 * A warning that only warns leaves the duplicate created, which is the harm.
 * This returns a preview instead, so the caller decides before anything is
 * written — the same shape the destructive tools use, though without their
 * `isError`, deliberately: calling those again repeats the destruction, while
 * calling this again creates nothing at all.
 *
 * Two identical coffees on one card on one day are a real thing, so the way
 * through is one flag and one more call, not an argument.
 */
const NOTHING_CREATED = 'so nothing was created:';

/**
 * Did this come back instead of a transaction?
 *
 * A tool that creates *through* `create_transaction` has to know, or it
 * announces work it did not do. `reconcile_currency_residual` printed
 * "Currency residual reconciled" above this very text, with the balance
 * unchanged. The predicate sits next to the sentence it matches so the two
 * cannot drift apart.
 */
export function isDuplicatePreview(lines: string[]): boolean {
  return lines.length > 0 && lines[0].endsWith(NOTHING_CREATED);
}

export function describePossibleDuplicates(
  existing: ExistingTransaction[],
  accountName: string,
): string[] {
  const lines = [
    existing.length === 1
      ? `A transaction like this one already exists, ${NOTHING_CREATED}`
      : `${existing.length} transactions like this one already exist, ${NOTHING_CREATED}`,
    '',
  ];

  for (const t of existing) {
    const bits = [t.date, formatMoney(t.amount), accountName];
    if (t.payeeName) bits.push(t.payeeName);
    if (t.notes) bits.push(t.notes);
    // Said, not left to be inferred: the far leg of a transfer is an ordinary
    // row in this account and reads as income or spending that was already
    // recorded. Knowing it is a transfer is what tells the caller whether
    // their own entry is the duplicate or the other half of a movement.
    if (t.isTransfer) bits.push('(one leg of a transfer)');
    lines.push(`  ${bits.join('  ')}`);
    lines.push(`    id: ${t.id}`);
  }

  lines.push(
    '',
    'Same account, same date, same amount. If this is a second, genuine payment',
    'rather than the same one recorded twice, call again with allow_duplicate: true.',
  );
  return lines;
}
