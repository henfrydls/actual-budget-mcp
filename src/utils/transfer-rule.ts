/**
 * When a payee that names an account means a transfer, and what that does to
 * the budget.
 *
 * Shared rather than written twice (#154). `create_transaction` and
 * `create_transactions` answered the same row differently: one made a transfer,
 * the other refused it and pointed at `create_transfer`. Two copies of a rule
 * drift, and this one had already drifted before anyone wrote it down twice.
 *
 * The rule, from #24 and #137:
 *
 *   A payee that is the name of another account asks for a transfer, and both
 *   sides of it are created. Unless a category was given **and both accounts
 *   are on budget**: between two on-budget accounts the money has not left the
 *   budget, so there is nothing to categorise and Actual drops the category.
 *   Naming one says the opposite of a transfer. That is the prepaid card topped
 *   up at a station called "Fuel Station", where an account and a shop share a
 *   name.
 *
 *   As soon as **either** account is off budget, money is crossing the budget's
 *   edge and the transfer is the point. The category survives there, on the row
 *   it was asked for.
 *
 * Measured through `addTransactions` with `runTransfers`, which is the path
 * both tools use, for all four combinations:
 *
 *   on  -> on    the rule applies: an ordinary purchase, no counterpart
 *   on  -> off   transfer, category kept on the source row
 *   off -> on    transfer, category kept on the source row
 *   off -> off   transfer, **category discarded by the engine**
 *
 * The last line is a correction. #137 recorded it as kept, and it looks kept:
 * read straight after the write the category is there. Read again after any
 * few calls into the engine it is gone, on that combination only. So the tool
 * was telling people their category was stored on a row that no longer had
 * one. Nothing here can keep it, since Actual removes it again; what the tools
 * can do is say so, which both now do.
 *
 * Counterparts never carry it, in any combination. The category lives on the
 * row it was asked for.
 */

/** The parts of an account this needs. `getAccounts()` returns more. */
export interface AccountLike {
  id: string;
  name: string;
  closed?: boolean;
  offbudget?: boolean;
}

export interface TransferTarget {
  id: string;
  name: string;
  offBudget: boolean;
}

export function isOffBudget(account: AccountLike | undefined): boolean {
  return Boolean(account?.offbudget);
}

/**
 * The account this row is a transfer to, or undefined if it is an ordinary row.
 *
 * Throws when the payee names the row's own account, which is not a transfer
 * and not an ordinary payee either.
 */
export function findTransferTarget(options: {
  accounts: readonly AccountLike[];
  sourceAccountId: string;
  payee?: string;
  hasCategory: boolean;
}): TransferTarget | undefined {
  const { accounts, sourceAccountId, payee, hasCategory } = options;
  if (!payee) return undefined;

  // Trimmed before comparing, on both sides. A payee of " Tarjeta " was not
  // recognised as the account, so an ordinary payee called "Tarjeta" was
  // created and the row went in with no counterpart. In the Actual app that
  // row reads exactly like a transfer, with nothing on the other account to
  // match it, which is worse than refusing it.
  const wanted = payee.trim();
  if (wanted === '') return undefined;

  const lower = wanted.toLowerCase();
  // `!a.closed` is belt and braces: measured, `getAccounts()` leaves closed
  // accounts out of the list altogether rather than returning them with the
  // flag set, so a closed account's name falls through and becomes an ordinary
  // payee either way. Which is the right answer, since there is nothing to
  // transfer into.
  const open = accounts.filter((a) => !a.closed);
  const byId = open.find((a) => a.id === wanted);
  // By the whole name, never by part of it: a shop called "Tarjeta de Credito"
  // is not the "Tarjeta" account, and turning a purchase into a transfer is
  // the harm #137 is about.
  const matches = byId ? [byId] : open.filter((a) => a.name.trim().toLowerCase() === lower);

  if (matches.length === 0) return undefined;
  if (matches.length > 1) {
    // Actual allows two accounts to share a name, and the field that takes an
    // account already refuses to guess between them (#155). Picking the first
    // silently would move money to whichever one came back first from the
    // database, which nobody can see from the reply.
    throw new Error(
      `Ambiguous account name "${payee}". Matches: ${matches.map((a) => a.name).join(', ')}. ` +
        'Give the account id instead, or rename one of them.',
    );
  }
  const target = matches[0];

  if (target.id === sourceAccountId) {
    throw new Error('Cannot transfer to the same account.');
  }

  const offBudget = isOffBudget(target);
  const sourceOffBudget = isOffBudget(accounts.find((a) => a.id === sourceAccountId));
  // The rule applies only when **both** sides are on budget. Two earlier
  // versions of it got this wrong, each by looking at one side: first every
  // target, which turned a contribution into a plain expense with no
  // counterpart, then the target alone, so spending *from* an off-budget
  // account lost its counterpart the same way.
  if (hasCategory && !offBudget && !sourceOffBudget) return undefined;

  return { id: target.id, name: target.name, offBudget };
}

/**
 * What a transfer did to the budget, worked out from the two rows.
 *
 * Each transfer is two rows: the source account gets `amountCents` and the
 * other gets its negative. Only rows in on-budget accounts count, so the effect
 * is their sum: zero between two on-budget accounts, because the money only
 * moved.
 *
 * From the rows and not from which accounts are off budget, because deciding by
 * combination was wrong twice in a row, both times on the sign. With a positive
 * amount the money runs the other way, so "left your budget" and "came into
 * your budget" swapped places and the reply said the opposite of what the
 * engine had done.
 */
export function budgetEffect(options: {
  amountCents: number;
  sourceOffBudget: boolean;
  targetOffBudget: boolean;
}): number {
  const { amountCents, sourceOffBudget, targetOffBudget } = options;
  return (sourceOffBudget ? 0 : amountCents) + (targetOffBudget ? 0 : -amountCents);
}

/**
 * Which of the four things happened, in one word.
 *
 * `inside` and `outside` are both an effect of zero and mean opposite things,
 * so the flags tell them apart; the direction of a crossing comes from the
 * sign, which is the part that cannot be read off the flags.
 */
export type TransferEffect = 'inside' | 'outside' | 'incoming' | 'outgoing';

export function transferEffect(options: {
  amountCents: number;
  sourceOffBudget: boolean;
  targetOffBudget: boolean;
}): TransferEffect {
  const { sourceOffBudget, targetOffBudget } = options;
  if (!sourceOffBudget && !targetOffBudget) return 'inside';
  if (sourceOffBudget && targetOffBudget) return 'outside';
  return budgetEffect(options) > 0 ? 'incoming' : 'outgoing';
}

/**
 * One key for both halves of the same movement.
 *
 * A pay-off read from two statements arrives as two rows: `{Bank, -800, payee
 * "Card"}` and `{Card, +800, payee "Bank"}`. They are one movement seen from
 * each side, and each one asks the engine to create both legs, so recording
 * them both leaves the payment in the budget twice. Nothing noticed, because a
 * check keyed on account, date and amount sees two different accounts.
 *
 * The key is the pair of accounts in the direction the money actually runs,
 * which the sign decides, plus the date and the size of it. The two rows above
 * both come out as `Bank>Card|date|80000`.
 */
export function transferPairKey(options: {
  sourceAccountId: string;
  targetAccountId: string;
  amountCents: number;
  date: string;
}): string {
  const { sourceAccountId, targetAccountId, amountCents, date } = options;
  const [from, to] =
    amountCents < 0 ? [sourceAccountId, targetAccountId] : [targetAccountId, sourceAccountId];
  return `${from}>${to}|${date}|${Math.abs(amountCents)}`;
}
