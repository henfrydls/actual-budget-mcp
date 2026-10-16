import { formatMoney } from './money.js';
import { isOffBudget, transferEffect, type AccountLike, type TransferEffect } from './transfer-rule.js';
import type { SavedRow } from './write-marker.js';

/**
 * The legs of a transfer, read from the budget rather than from the request.
 *
 * One transaction can move money more than once. A rule can split it, and
 * `addTransfer` returns early on a split parent, so each part becomes a
 * transfer of its own: measured against the engine, a row split in half and
 * sent to an account produced two linked parts and two matching rows, while
 * the reply read the parent, found no link, and said nothing had been created
 * anywhere.
 *
 * Each part can also go somewhere else. A rule that puts another account's
 * transfer payee on one part sends that part there, so one transaction can
 * leave the budget on one side and stay inside it on the other.
 *
 * Reading them as a list is what stops this being a sequence of special
 * cases. A plain transfer has one leg and reads as it always did; everything
 * else is the same list with more in it (#184).
 */
export interface TransferLeg {
  /**
   * The row that carries the link: the transaction, or one of its parts.
   * Absent when the budget could not be read and the leg is what was asked
   * for rather than what happened.
   */
  row?: SavedRow;
  /** Where the money went or came from. */
  accountId: string;
  accountName: string;
  offBudget: boolean;
  /** This leg's own amount, which on a split is the part's. */
  amountCents: number;
  effect: TransferEffect;
}

export function transferLegs(options: {
  saved: SavedRow | null;
  parts: SavedRow[];
  accounts: AccountLike[];
  sourceOffBudget: boolean;
  /** Where the caller asked to send it, for a leg whose account cannot be read. */
  fallbackName?: string;
  fallbackOffBudget?: boolean;
}): TransferLeg[] {
  const { saved, parts, accounts, sourceOffBudget } = options;
  if (!saved) return [];
  const rows = saved.isParent ? parts : [saved];
  const legs: TransferLeg[] = [];
  for (const row of rows) {
    if (row.transferId === null) continue;
    const account = row.payeeTransferAccount
      ? accounts.find((a) => a.id === row.payeeTransferAccount)
      : undefined;
    const accountName = account?.name ?? options.fallbackName ?? 'another account';
    const offBudget = account ? isOffBudget(account) : (options.fallbackOffBudget ?? false);
    legs.push({
      row,
      accountId: account?.id ?? row.payeeTransferAccount ?? '',
      accountName,
      offBudget,
      amountCents: row.amount,
      effect: transferEffect({
        amountCents: row.amount,
        sourceOffBudget,
        targetOffBudget: offBudget,
      }),
    });
  }
  return legs;
}

/**
 * Whether Actual is going to take the category off this leg.
 *
 * `clearCategory` compares the two accounts' `offbudget` flags, clears both
 * rows when they match, and runs again on every update. It runs after the row
 * can first be read, so this is decided by the engine's rule and not by
 * looking: measured, the row holds the category and two seconds later it does
 * not, and forcing it back only triggers the clear again.
 */
export function clearsCategory(leg: TransferLeg, sourceOffBudget: boolean): boolean {
  return leg.offBudget === sourceOffBudget;
}

/** What each label in a summary means, said once however many legs earned it. */
export const EFFECT_LABEL: Record<TransferEffect, string> = {
  inside: 'inside your budget',
  outside: 'outside your budget',
  incoming: 'came into your budget',
  outgoing: 'left your budget',
};

export const EFFECT_PARAGRAPH: Record<TransferEffect, string> = {
  inside:
    'Inside your budget means the money only changed account, so it is not spending. To ' +
    'record a purchase instead, give the row a category, or use a payee that is not an ' +
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
 * One paragraph per kind of effect that happened, in a fixed order so two
 * replies about the same movement read the same way.
 */
export function effectParagraphs(legs: TransferLeg[]): string[] {
  const kinds: TransferEffect[] = ['inside', 'outgoing', 'incoming', 'outside'];
  const lines: string[] = [];
  for (const kind of kinds) {
    if (legs.some((leg) => leg.effect === kind)) lines.push('', EFFECT_PARAGRAPH[kind]);
  }
  return lines;
}

/** A leg with the name of whatever the reply is calling it. */
export interface LabelledLeg {
  label: string;
  /** The account the transaction itself is in. */
  from: string;
  leg: TransferLeg;
  /** Anything worth adding after the effect, such as a rule having redirected it. */
  note?: string;
}

/**
 * The legs as a table, aligned.
 *
 * The direction comes from the sign, not from which account the row was
 * written to: a positive amount is money arriving, so the other account is
 * where it came from. Reading it the other way says the opposite of what the
 * engine did, which is the mistake #137 made twice.
 */
export function legTable(entries: LabelledLeg[]): string[] {
  const routes = entries.map(({ from, leg }) =>
    leg.amountCents >= 0 ? `${leg.accountName} -> ${from}` : `${from} -> ${leg.accountName}`,
  );
  const amounts = entries.map(({ leg }) => formatMoney(Math.abs(leg.amountCents)));
  // The label is not padded: it was not before, and padding it moves every
  // line of a batch whose row numbers reach two digits.
  const routeWidth = Math.max(...(routes.length ? routes.map((r) => r.length) : [0]));
  const amountWidth = Math.max(...(amounts.length ? amounts.map((a) => a.length) : [0]));
  return entries.map(
    (entry, index) =>
      `  ${entry.label}  ${routes[index].padEnd(routeWidth)}  ` +
      `${amounts[index].padStart(amountWidth)}  ${EFFECT_LABEL[entry.leg.effect]}` +
      (entry.note ? `  ${entry.note}` : ''),
  );
}

/**
 * The leg the caller asked for, for when the budget cannot be read.
 *
 * A reply that repeats the request is worse than one that reads the row, and
 * better than one that says nothing at all. It carries no row, which is how
 * everything else knows not to claim a rule changed anything.
 */
export function requestedLeg(options: {
  accountId: string;
  accountName: string;
  offBudget: boolean;
  amountCents: number;
  sourceOffBudget: boolean;
}): TransferLeg {
  const { accountId, accountName, offBudget, amountCents, sourceOffBudget } = options;
  return {
    accountId,
    accountName,
    offBudget,
    amountCents,
    effect: transferEffect({ amountCents, sourceOffBudget, targetOffBudget: offBudget }),
  };
}
