import { describe, it, expect } from 'vitest';
import { pairCounterparts, daysApart, type PairableRow } from '../counterpart-pairing.js';

/**
 * The pairing, as a matching problem (#161).
 *
 * Checked here rather than only through the batch because what has to hold is
 * a property of the arrangement, not of one example: every batch where a
 * better pairing exists is a batch where a row that collides is reported back
 * as fine. The two cases that reached this point, both found by someone
 * trying a shape nobody had thought of, were of exactly that kind.
 */
describe('pairing the two sides of one movement', () => {
  const CARD = 'card';
  const BANK = 'bank';

  const transfer = (index: number, date: string, amount = -800): PairableRow => ({
    index,
    accountId: BANK,
    amountCents: amount,
    date,
    transferTargetId: CARD,
  });
  const ordinary = (index: number, date: string, amount = 800): PairableRow => ({
    index,
    accountId: CARD,
    amountCents: amount,
    date,
  });

  it('pairs the obvious one', () => {
    expect(pairCounterparts([transfer(0, '2026-09-25'), ordinary(1, '2026-09-25')], 1)).toEqual([
      { transfer: 0, ordinary: 1 },
    ]);
  });

  it('prefers the exact date where the choice is free', () => {
    const pairs = pairCounterparts(
      [transfer(0, '2026-09-26'), transfer(1, '2026-09-25'), ordinary(2, '2026-09-25')],
      1,
    );
    expect(pairs).toEqual([{ transfer: 1, ordinary: 2 }]);
  });

  it('displaces a pairing when the row holding it has somewhere else to go', () => {
    // Two transfers, two credits, the card posting a day late. Taking the
    // exact-date pair and keeping it uses up the transfer the second credit
    // needs.
    const pairs = pairCounterparts(
      [
        transfer(0, '2026-09-25'),
        transfer(1, '2026-09-26'),
        ordinary(2, '2026-09-26'),
        ordinary(3, '2026-09-27'),
      ],
      1,
    );
    expect(pairs).toHaveLength(2);
    expect(new Set(pairs.map((p) => p.ordinary))).toEqual(new Set([2, 3]));
    expect(new Set(pairs.map((p) => p.transfer))).toEqual(new Set([0, 1]));
  });

  it('leaves out a row that is already reported for something else', () => {
    // A batch holding the same credit twice: the repeat is marked elsewhere,
    // and if it still takes a transfer with it, its twin is never named and
    // the reply counts it among the rows that were fine.
    const rows = [
      transfer(0, '2026-09-24'),
      transfer(1, '2026-09-25'),
      ordinary(2, '2026-09-24'),
      ordinary(3, '2026-09-24'),
      ordinary(4, '2026-09-25'),
    ];
    const pairs = pairCounterparts(rows, 1, new Set([3]));

    expect(pairs).toEqual([
      { transfer: 0, ordinary: 2 },
      { transfer: 1, ordinary: 4 },
    ]);
  });

  it('leaves out a transfer that is already reported', () => {
    // A transfer reported for something else is a row that is going away, so
    // naming it as the explanation sends the reader to the wrong line. Here
    // the reported transfer is the nearer one, so including it would win the
    // pairing on distance.
    const rows = [
      transfer(0, '2026-09-26'),
      transfer(1, '2026-09-25'),
      ordinary(2, '2026-09-25'),
    ];

    expect(pairCounterparts(rows, 1, new Set([1]))).toEqual([{ transfer: 0, ordinary: 2 }]);
    // Without the exclusion the nearer, reported one wins.
    expect(pairCounterparts(rows, 1)).toEqual([{ transfer: 1, ordinary: 2 }]);
  });

  it('counts days, not hours', () => {
    // The day a clock goes back is twenty-five hours long.
    expect(daysApart('2026-11-01', '2026-11-02')).toBe(1);
    expect(daysApart('2026-02-28', '2026-03-01')).toBe(1);
    expect(daysApart('2026-12-31', '2027-01-01')).toBe(1);
    expect(daysApart('2026-09-25', '2026-09-27')).toBe(2);
  });

  /**
   * The property, over batches nobody wrote by hand.
   *
   * Both faults found in review were arrangements where a better pairing
   * existed and the code did not find it, so that is what this asserts,
   * against a brute-force maximum.
   *
   * The first version of this generator spread its rows over three accounts,
   * two amounts and either sign, and almost never produced two rows competing
   * for the same transfer: a greedy pairing passed all three hundred batches.
   * A property that cannot fail for the reason it was written is worse than no
   * property, because it is read as cover. So the rows are concentrated into
   * the shape the fault lives in, one pair of accounts and one amount over a
   * handful of days, and a test below insists the generator keeps producing
   * batches where greedy and maximum disagree.
   */
  describe('over generated batches', () => {
    /** A small deterministic generator, so a failure can be re-run. */
    function makeRandom(seed: number): () => number {
      let state = seed >>> 0;
      return () => {
        state = (state * 1_664_525 + 1_013_904_223) >>> 0;
        return state / 0x1_0000_0000;
      };
    }

    /**
     * Six consecutive days, and batches of four to sixteen rows.
     *
     * Measured while choosing it, counting how many of three hundred batches
     * a greedy pairing would get wrong:
     *
     *   2 days,  4 to 12 rows     0     every row sees every other, greedy is right
     *   3 days,  2 to 10 rows    12
     *   4 days,  2 to 10 rows     7
     *   6 days,  4 to 16 rows    36
     *   8 days,  6 to 18 rows    22
     *
     * The disagreements come from the edges, where a row has one candidate
     * and another takes it, so a window that every row can see produces none
     * at all. The first version of this spread rows over three accounts and
     * two amounts and found almost no edges.
     */
    const DATES = [
      '2026-09-22',
      '2026-09-23',
      '2026-09-24',
      '2026-09-25',
      '2026-09-26',
      '2026-09-27',
    ];

    /**
     * One batch, in the shape a month of statements arrives in: payments out
     * of one account and credits on one card, same amount, a few days apart.
     * Some rows come back marked, as they would after the duplicate checks.
     */
    function makeBatch(random: () => number): { rows: PairableRow[]; skip: Set<number> } {
      const size = 4 + Math.floor(random() * 13);
      const rows: PairableRow[] = [];
      const skip = new Set<number>();
      for (let index = 0; index < size; index += 1) {
        const isTransfer = random() < 0.5;
        const date = DATES[Math.floor(random() * DATES.length)];
        rows.push(
          isTransfer
            ? { index, accountId: BANK, amountCents: -800, date, transferTargetId: CARD }
            : { index, accountId: CARD, amountCents: 800, date },
        );
        // Roughly one row in six arrives already reported, for a repeat or a
        // bank id, which is where the last fault was.
        if (random() < 0.17) skip.add(index);
      }
      return { rows, skip };
    }

    /** The largest matching, by trying every assignment. */
    function bruteForceMax(
      rows: readonly PairableRow[],
      windowDays: number,
      skip: ReadonlySet<number>,
    ): number {
      const transfers = rows.filter((r) => r.transferTargetId && !skip.has(r.index));
      const ordinaries = rows.filter((r) => !r.transferTargetId && !skip.has(r.index));
      const fits = (t: PairableRow, o: PairableRow): boolean =>
        t.transferTargetId === o.accountId &&
        t.amountCents === -o.amountCents &&
        daysApart(t.date, o.date) <= windowDays;

      const best = (oi: number, used: Set<number>): number => {
        if (oi >= ordinaries.length) return 0;
        let most = best(oi + 1, used);
        for (let ti = 0; ti < transfers.length; ti += 1) {
          if (used.has(ti)) continue;
          if (!fits(transfers[ti], ordinaries[oi])) continue;
          used.add(ti);
          most = Math.max(most, 1 + best(oi + 1, used));
          used.delete(ti);
        }
        return most;
      };
      return best(0, new Set());
    }

    /**
     * What the code did before: each row takes its nearest free candidate and
     * keeps it. Here so the generator can be held to producing batches where
     * this is not enough.
     */
    function greedyCount(
      rows: readonly PairableRow[],
      windowDays: number,
      skip: ReadonlySet<number>,
    ): number {
      const transfers = rows.filter((r) => r.transferTargetId && !skip.has(r.index));
      const taken = new Set<number>();
      let count = 0;
      for (const o of rows) {
        if (o.transferTargetId || skip.has(o.index)) continue;
        const candidate = transfers
          .filter(
            (t) =>
              !taken.has(t.index) &&
              t.transferTargetId === o.accountId &&
              t.amountCents === -o.amountCents &&
              daysApart(t.date, o.date) <= windowDays,
          )
          .sort((a, b) => daysApart(a.date, o.date) - daysApart(b.date, o.date) || a.index - b.index)[0];
        if (candidate) {
          taken.add(candidate.index);
          count += 1;
        }
      }
      return count;
    }

    const SEED = 20_261_012;
    const BATCHES = 300;

    it('always finds as many pairs as exist, and never reuses a row', () => {
      const random = makeRandom(SEED);

      for (let batch = 0; batch < BATCHES; batch += 1) {
        const { rows, skip } = makeBatch(random);
        const pairs = pairCounterparts(rows, 1, skip);
        const where = `batch ${batch}, skip ${[...skip]}: ${JSON.stringify(rows)}`;

        expect(pairs.length, `fewer pairs than exist in ${where}`).toBe(
          bruteForceMax(rows, 1, skip),
        );
        expect(new Set(pairs.map((p) => p.transfer)).size, `a transfer used twice in ${where}`).toBe(
          pairs.length,
        );
        expect(new Set(pairs.map((p) => p.ordinary)).size, `a row used twice in ${where}`).toBe(
          pairs.length,
        );
        for (const pair of pairs) {
          const t = rows.find((r) => r.index === pair.transfer)!;
          const o = rows.find((r) => r.index === pair.ordinary)!;
          expect(skip.has(t.index), `paired a reported transfer in ${where}`).toBe(false);
          expect(skip.has(o.index), `paired a reported row in ${where}`).toBe(false);
          expect(t.transferTargetId, `paired across accounts in ${where}`).toBe(o.accountId);
          expect(t.amountCents, `paired unequal amounts in ${where}`).toBe(-o.amountCents);
          expect(
            daysApart(t.date, o.date),
            `paired outside the window in ${where}`,
          ).toBeLessThanOrEqual(1);
        }
      }
    });

    it('keeps producing batches where greedy is not enough', () => {
      // The property above can only catch a greedy pairing on a batch where
      // greedy and maximum disagree. Asking for batches that merely contain a
      // pair is not the same thing, and that is what the first version asked
      // for: it passed with the greedy code in place.
      const random = makeRandom(SEED);
      let contested = 0;

      for (let batch = 0; batch < BATCHES; batch += 1) {
        const { rows, skip } = makeBatch(random);
        if (greedyCount(rows, 1, skip) < bruteForceMax(rows, 1, skip)) contested += 1;
      }

      // 36 of 300 as written. The floor leaves room for the generator to
      // drift a little without the property quietly going hollow.
      expect(contested, 'no batch would catch a greedy pairing').toBeGreaterThan(20);
    });

    it('produces batches with rows already reported', () => {
      // The other half of what the property has to cover.
      const random = makeRandom(SEED);
      let withSkips = 0;
      for (let batch = 0; batch < BATCHES; batch += 1) {
        if (makeBatch(random).skip.size > 0) withSkips += 1;
      }
      expect(withSkips, 'nothing was ever marked').toBeGreaterThan(100);
    });
  });
});
