/**
 * Which rows in one batch are the two sides of the same movement.
 *
 * A card statement lists a payment as something like "PAYMENT RECEIVED", not
 * as an account name, so a month read off both statements arrives as a
 * transfer from the current account and an ordinary credit on the card. The
 * transfer writes that credit itself, so keeping both records the money twice
 * (#161).
 *
 * ## Why this is a matching problem and not a search
 *
 * A transfer writes one counterpart, so it can account for one row. Taking the
 * nearest candidate for each row in turn is not the same as pairing as many
 * rows as possible, and the difference is a message that is wrong rather than
 * merely incomplete: a row left unpaired is reported back as one of the rows
 * that "were fine", and the person sends it again on its own and hits the
 * collision on the second attempt.
 *
 * Measured on two transfers and two credits where the card posts a day late:
 * taking the exact-date pair first used up the transfer the second credit
 * needed. So this takes the arrangement that pairs the most rows, letting a
 * pairing be displaced when the row holding it has somewhere else to go.
 *
 * Candidates are ordered by distance, so an exact date wins where the choice
 * is free, and rows are visited in the order they were sent, so one batch
 * always reads the same way.
 */

export interface PairableRow {
  /** Position in the batch, which is what the reply names. */
  index: number;
  accountId: string;
  amountCents: number;
  /** `YYYY-MM-DD`. */
  date: string;
  /** For a transfer row, the account its counterpart lands in. */
  transferTargetId?: string;
}

export interface CounterpartPair {
  /** Index of the transfer row. */
  transfer: number;
  /** Index of the ordinary row that is its other side. */
  ordinary: number;
}

/**
 * Whole days between two `YYYY-MM-DD` dates.
 *
 * Through `Date.UTC`, which has no offsets to change. Parsing both as local
 * midnight and comparing milliseconds is wrong on the day a clock goes back:
 * that day is twenty-five hours long, so two consecutive dates stop being
 * within one day. Measured with TZ=America/New_York on 1 and 2 November, the
 * pair went unrecognised and the money was written twice.
 */
export function daysApart(a: string, b: string): number {
  const toDay = (date: string): number => {
    const [year, month, day] = date.split('-').map(Number);
    return Date.UTC(year, month - 1, day) / 86_400_000;
  };
  return Math.abs(toDay(a) - toDay(b));
}

export function pairCounterparts(
  rows: readonly PairableRow[],
  windowDays: number,
  /**
   * Rows to leave out, by index.
   *
   * A row already reported for something else must not take a transfer with
   * it. A batch holding the same credit twice marked the repeat, and that
   * repeat still consumed the transfer its twin needed, so the twin was never
   * named and the reply counted it among the rows that were fine.
   */
  skip: ReadonlySet<number> = new Set(),
): CounterpartPair[] {
  const transfers = rows.filter((row) => row.transferTargetId && !skip.has(row.index));
  if (transfers.length === 0) return [];

  /** Transfers each ordinary row could be the other side of, nearest first. */
  const options = new Map<number, number[]>();
  for (const ordinary of rows) {
    if (ordinary.transferTargetId || skip.has(ordinary.index)) continue;
    const fits = transfers
      .filter(
        (t) =>
          t.transferTargetId === ordinary.accountId &&
          t.amountCents === -ordinary.amountCents &&
          daysApart(t.date, ordinary.date) <= windowDays,
      )
      .map((t) => ({ index: t.index, apart: daysApart(t.date, ordinary.date) }))
      .sort((a, b) => a.apart - b.apart || a.index - b.index)
      .map((t) => t.index);
    if (fits.length > 0) options.set(ordinary.index, fits);
  }

  /** Which ordinary row each transfer is currently paired with. */
  const pairedWith = new Map<number, number>();

  const assign = (ordinaryIndex: number, tried: Set<number>): boolean => {
    for (const transferIndex of options.get(ordinaryIndex) ?? []) {
      if (tried.has(transferIndex)) continue;
      tried.add(transferIndex);
      const holder = pairedWith.get(transferIndex);
      if (holder === undefined || assign(holder, tried)) {
        pairedWith.set(transferIndex, ordinaryIndex);
        return true;
      }
    }
    return false;
  };

  for (const ordinaryIndex of [...options.keys()].sort((a, b) => a - b)) {
    assign(ordinaryIndex, new Set<number>());
  }

  return [...pairedWith.entries()]
    .map(([transfer, ordinary]) => ({ transfer, ordinary }))
    .sort((a, b) => a.ordinary - b.ordinary);
}
