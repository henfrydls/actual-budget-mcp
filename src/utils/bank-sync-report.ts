import * as api from '@actual-app/api';
import { formatMoney } from './money.js';

/**
 * What a bank sync brought in, from what the engine says it did (#221).
 *
 * From Actual 26.11 `runBankSync` answers
 * `{ newTransactions, matchedTransactions, updatedAccounts }`, each a list of
 * ids. Before that it answered nothing at all, so the tool could only say the
 * sync had run and the caller had to go and look.
 *
 * Ids, not rows: the engine hands back what it touched and the rows have to
 * be read back to say anything about them. They are read per account, over a
 * window, because that is the only public way to ask for a transaction.
 *
 * Both shapes are handled on purpose. The library this repository pins today
 * returns `undefined`, the next one returns the object, and the reply should
 * be the best it can be on either rather than waiting for a release to say
 * anything at all.
 */
export interface SyncOutcome {
  newTransactions?: string[];
  matchedTransactions?: string[];
  updatedAccounts?: string[];
}

/** A row as the reply names it. */
interface Added {
  date: string;
  amount: number;
  payee: string;
  account: string;
}

/** How far back to look for the rows the sync named. */
const WINDOW_DAYS = 120;

function windowStart(): string {
  const from = new Date();
  from.setDate(from.getDate() - WINDOW_DAYS);
  return from.toISOString().slice(0, 10);
}

/**
 * The rows behind the ids, read per account.
 *
 * A sync that brought in nothing reads nothing: the ids decide which accounts
 * are opened at all.
 */
async function rowsFor(
  ids: Set<string>,
  accounts: Array<{ id: string; name: string }>,
  updated: string[],
): Promise<Added[]> {
  if (ids.size === 0) return [];
  const start = windowStart();
  const today = new Date().toISOString().slice(0, 10);
  const payees = await api.getPayees();
  const nameOf = new Map(payees.map((p) => [p.id, p.name]));

  const found: Added[] = [];
  // The accounts the engine said it touched, or all of them when it did not
  // say: an older library gives ids without naming the accounts.
  const toRead = updated.length > 0 ? accounts.filter((a) => updated.includes(a.id)) : accounts;
  for (const account of toRead) {
    const rows = (await api.getTransactions(account.id, start, today)) as Array<{
      id: string;
      date: string;
      amount: number;
      payee?: string;
      imported_payee?: string;
    }>;
    for (const row of rows) {
      if (!ids.has(row.id)) continue;
      found.push({
        date: row.date,
        amount: row.amount,
        payee: nameOf.get(row.payee ?? '') ?? row.imported_payee ?? '(no payee)',
        account: account.name,
      });
    }
  }
  return found.sort((a, b) => (a.date === b.date ? 0 : a.date < b.date ? 1 : -1));
}

/**
 * The lines that say what came in.
 *
 * How many were added and how many matched an existing row, then the added
 * ones, so the next step can start from the reply rather than from another
 * call. Matched rows are counted and not listed: they are rows the reader
 * already has.
 */
export async function describeSync(
  outcome: SyncOutcome | undefined,
  accounts: Array<{ id: string; name: string }>,
): Promise<string[]> {
  // An older library says nothing about what it did, and saying nothing is
  // better than guessing from a table that other things also write to.
  if (outcome === undefined || outcome === null) return [];

  const added = outcome.newTransactions ?? [];
  const matched = outcome.matchedTransactions ?? [];
  const updated = outcome.updatedAccounts ?? [];

  if (added.length === 0 && matched.length === 0) {
    return ['Nothing new came in.'];
  }

  const lines = [
    `${added.length} new ${added.length === 1 ? 'transaction' : 'transactions'}, ` +
      `${matched.length} matched to rows already there.`,
  ];

  const rows = await rowsFor(new Set(added), accounts, updated);
  if (rows.length > 0) {
    lines.push('');
    const width = Math.max(...rows.map((r) => r.payee.length));
    for (const row of rows) {
      lines.push(
        `  ${row.date}  ${formatMoney(row.amount).padStart(12)}  ${row.payee.padEnd(width)}  ${row.account}`,
      );
    }
  }
  // Ids the engine named and the window did not reach. Saying the count is
  // honest; printing nothing and letting the two figures disagree is not.
  if (rows.length < added.length) {
    lines.push(
      '',
      `${added.length - rows.length} of them are not listed: they are dated outside the last ` +
        `${WINDOW_DAYS} days, which is as far back as this looks.`,
    );
  }
  return lines;
}
