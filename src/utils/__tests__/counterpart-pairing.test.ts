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

    /** The largest matching, by trying every assignment. */
    function bruteForceMax(rows: readonly PairableRow[], windowDays: number): number {
      const transfers = rows.filter((r) => r.transferTargetId);
      const ordinaries = rows.filter((r) => !r.transferTargetId);
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

    it('always finds as many pairs as exist, and never reuses a row', () => {
      const random = makeRandom(20_261_012);
      const accounts = ['a', 'b', 'c'];
      const amounts = [800, 1250];
      const dates = ['2026-09-24', '2026-09-25', '2026-09-26', '2026-09-27', '2026-09-28'];
      const pick = <T>(list: readonly T[]): T => list[Math.floor(random() * list.length)];

      for (let batch = 0; batch < 300; batch += 1) {
        const size = 2 + Math.floor(random() * 9);
        const rows: PairableRow[] = [];
        for (let index = 0; index < size; index += 1) {
          const account = pick(accounts);
          const amount = pick(amounts);
          const isTransfer = random() < 0.5;
          const target = pick(accounts.filter((a) => a !== account));
          rows.push({
            index,
            accountId: account,
            amountCents: random() < 0.5 ? amount : -amount,
            date: pick(dates),
            ...(isTransfer ? { transferTargetId: target } : {}),
          });
        }

        const pairs = pairCounterparts(rows, 1);
        const where = `batch ${batch}: ${JSON.stringify(rows)}`;

        expect(pairs.length, `fewer pairs than exist in ${where}`).toBe(bruteForceMax(rows, 1));
        expect(new Set(pairs.map((p) => p.transfer)).size, `a transfer used twice in ${where}`).toBe(
          pairs.length,
        );
        expect(new Set(pairs.map((p) => p.ordinary)).size, `a row used twice in ${where}`).toBe(
          pairs.length,
        );
        for (const pair of pairs) {
          const t = rows.find((r) => r.index === pair.transfer)!;
          const o = rows.find((r) => r.index === pair.ordinary)!;
          expect(t.transferTargetId, `paired across accounts in ${where}`).toBe(o.accountId);
          expect(t.amountCents, `paired unequal amounts in ${where}`).toBe(-o.amountCents);
          expect(daysApart(t.date, o.date), `paired outside the window in ${where}`).toBeLessThanOrEqual(1);
        }
      }
    });

    it('generates batches worth testing, not a field of nothing', () => {
      // A generator that produced no pairable rows would make the property
      // above pass over an empty set every time.
      const random = makeRandom(20_261_012);
      const accounts = ['a', 'b', 'c'];
      const amounts = [800, 1250];
      const dates = ['2026-09-24', '2026-09-25', '2026-09-26', '2026-09-27', '2026-09-28'];
      const pick = <T>(list: readonly T[]): T => list[Math.floor(random() * list.length)];

      let withPairs = 0;
      for (let batch = 0; batch < 300; batch += 1) {
        const size = 2 + Math.floor(random() * 9);
        const rows: PairableRow[] = [];
        for (let index = 0; index < size; index += 1) {
          const account = pick(accounts);
          const amount = pick(amounts);
          const isTransfer = random() < 0.5;
          const target = pick(accounts.filter((a) => a !== account));
          rows.push({
            index,
            accountId: account,
            amountCents: random() < 0.5 ? amount : -amount,
            date: pick(dates),
            ...(isTransfer ? { transferTargetId: target } : {}),
          });
        }
        if (pairCounterparts(rows, 1).length > 0) withPairs += 1;
      }
      expect(withPairs, 'the generator produced almost nothing to pair').toBeGreaterThan(30);
    });
  });
});
