import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fakeQ, lastQuery } from '../../tools/__tests__/fake-query.js';

const asked: Array<Record<string, unknown>> = [];

vi.mock('@actual-app/api', () => ({
  default: {},
  q: (table: string) => fakeQ(table),
  runQuery: vi.fn().mockImplementation(async () => {
    asked.push({ ...lastQuery });
    return { data: [] };
  }),
  getPayees: vi.fn().mockResolvedValue([
    { id: 'p-1', name: 'Supermercado Nacional' },
  ]),
  utils: {
    amountToInteger: (a: number) => Math.round(a * 100),
    integerToAmount: (c: number) => c / 100,
  },
}));

import * as api from '@actual-app/api';
import { rowsDatedAfterToday, describeFutureRows } from '../future-dated.js';
import { resolveDate } from '../dates.js';

/**
 * #100. `getAccountBalance` counts `date <= today`, so a bank figure that
 * already includes a transaction dated ahead is not comparable to it, and the
 * difference lands in the residual category looking like currency drift.
 */
describe('rowsDatedAfterToday: the question it asks', () => {
  beforeEach(() => {
    asked.length = 0;
    vi.mocked(api.runQuery)
      .mockClear()
      .mockImplementation(async () => {
        asked.push({ ...lastQuery });
        return { data: [] } as never;
      });
  });

  it('asks for rows after today, in this account, excluding split parts', async () => {
    await rowsDatedAfterToday('acc-1', '2026-09-26');

    expect(asked[0].filter).toEqual({
      account: 'acc-1',
      date: { $gt: '2026-09-26' },
      is_child: false,
    });
  });

  it('uses the date it was given, and does not read a clock of its own', async () => {
    // It used to call `resolveDate('today')` here. That looked like one clock
    // because the tool also called `resolveDate`, but the two calls sat in
    // different modules with an `await` between them, so across midnight the
    // balance's cutoff and this `$gt` came from different days and a row dated
    // between them was in neither. The clock is read once, by the caller, and
    // passed; the test that the two agree now lives where both are visible, in
    // the tool.
    await rowsDatedAfterToday('acc-1', '2031-07-04');

    expect((asked[0].filter as { date: { $gt: string } }).date.$gt).toBe('2031-07-04');
  });

  it('asks for splits, so a purchase dated ahead is one row and not its parts', async () => {
    await rowsDatedAfterToday('acc-1', '2026-09-26');

    expect(asked[0].options).toEqual({ splits: 'all' });
    expect(asked[0].select).toContain('amount');
    expect(asked[0].select).toContain('date');
  });

  it('totals what it found, and resolves payee ids to names', async () => {
    vi.mocked(api.runQuery).mockResolvedValue({
      data: [
        { id: 't1', date: '2099-01-01', amount: -4000, payee: 'p-1', notes: null },
        { id: 't2', date: '2099-01-02', amount: -8000, payee: null, notes: 'later' },
      ],
    } as never);

    const { rows, total } = await rowsDatedAfterToday('acc-1', '2026-09-26');

    expect(total).toBe(-12000);
    expect(rows[0].payeeName).toBe('Supermercado Nacional');
    expect(rows[1].payeeName).toBeUndefined();
  });

  it('asks for the rows oldest first, not in whatever order AQL prefers', async () => {
    // Measured: with no ordering the engine returns them newest first, so the
    // nearest row, the one most likely to be at the bank already, was listed
    // last. An unstated default deciding what a reader sees first is the shape
    // `transactionsQuery` exists to stop.
    await rowsDatedAfterToday('acc-1', '2026-09-26');

    expect(asked[0].orderBy).toBe('date');
  });

  it('selects what says something about the bank, not what merely describes the row', async () => {
    await rowsDatedAfterToday('acc-1', '2026-09-26');

    expect(asked[0].select).toContain('imported_id');
    expect(asked[0].select).toContain('cleared');
  });

  it('marks a row that came from the bank, and one entered here unreconciled', async () => {
    // The signal is `imported_id`: a row carrying one arrived from the bank,
    // so the bank's figure counts it. A cleared row without one is neither
    // marked, because being reconciled in Actual is not the same as the bank
    // reporting it on a statement dated today.
    vi.mocked(api.runQuery).mockResolvedValue({
      data: [
        { id: 't1', date: '2099-01-01', amount: -4000, payee: null, notes: null, imported_id: 'b-1', cleared: true },
        { id: 't2', date: '2099-01-02', amount: -8000, payee: null, notes: null, cleared: false },
        { id: 't3', date: '2099-01-03', amount: -100, payee: null, notes: null, cleared: true },
      ],
    } as never);

    const { rows } = await rowsDatedAfterToday('acc-1', '2026-09-26');

    expect(rows.map((r) => r.cameFromBank)).toEqual([true, false, false]);
    expect(rows.map((r) => r.enteredByHand)).toEqual([false, true, false]);
  });

  it('finds nothing in an account with nothing ahead', async () => {
    expect(await rowsDatedAfterToday('acc-1', '2026-09-26')).toEqual({ rows: [], total: 0 });
  });
});

describe('describeFutureRows: the choice it lays out', () => {
  const rows = [
    { id: 't1', date: '2026-09-28', amount: -4000, payeeName: 'Farmacia', notes: null,
      cameFromBank: false, enteredByHand: false },
    { id: 't2', date: '2026-10-15', amount: -8000, payeeName: undefined, notes: 'rent',
      cameFromBank: false, enteredByHand: false },
  ];
  const text = () => describeFutureRows(rows, -12000, 'Card', -10000, -14000).join('\n');

  it('books nothing and says so first', () => {
    expect(text()).toMatch(/^No adjustment was booked for Card\./);
  });

  it('lists each row, with its date and amount', () => {
    expect(text()).toContain('2026-09-28');
    expect(text()).toContain('-40.00');
    expect(text()).toContain('Farmacia');
    expect(text()).toContain('2026-10-15');
    expect(text()).toContain('-80.00');
    expect(text()).toContain('rent');
  });

  it('shows both readings of the balance, not just the one it prefers', () => {
    const t = text();
    expect(t).toContain('Balance to today:        -100.00');
    expect(t).toContain('Those rows come to:      -120.00');
    expect(t).toContain('Balance counting them:   -220.00');
    expect(t).toContain('You said the bank says:  -140.00');
  });

  it('gives the adjustment each choice would book, under its own label', () => {
    // -140 against -100 is -40.00; against -220 it is 80.00.
    //
    // Two defects lived here, and the first fix caught one and claimed both.
    // A lazy `[\s\S]*?` matched `80.00` inside `-80.00`, so the sign was held
    // by nothing; whole-line `toContain` killed that. It did not kill the
    // other: with both lines present, `{-40.00, 80.00}` satisfies any set of
    // `toContain` over the joined text **in either order**, so swapping the
    // two figures told the caller the opposite number under each option and
    // passed all 587 tests in both modes.
    //
    // Nothing ties a figure to a label unless the assertion is scoped to the
    // label's own block, so it is scoped. The two `not.toContain` guards that
    // used to sit here are gone: no mutation of these two figures could turn
    // them red, and they occupied the slot where this belongs.
    const t = text();
    const blockFor = (label: string) => {
      const start = t.indexOf(`future_rows: "${label}"`);
      expect(start, `no block for ${label}`).toBeGreaterThan(-1);
      const rest = t.slice(start);
      const next = rest.indexOf('future_rows: "', 1);
      return next === -1 ? rest : rest.slice(0, next);
    };

    expect(blockFor('exclude')).toContain('Adjustment would be -40.00.');
    expect(blockFor('include')).toContain('Adjustment would be 80.00.');
  });

  it('puts each label on its own row, not merely somewhere in the text', () => {
    // Scoped to the row, for the reason the two adjustment figures are scoped
    // to their blocks three tests above: two unscoped `toMatch` over the
    // joined text are satisfied by both labels in either order, so swapping
    // them passed the whole suite in both modes. A purchase the bank had
    // posted would have read "entered here, not reconciled" and pushed toward
    // booking it twice, which is #100 with a printed argument for making the
    // same mistake.
    //
    // The technique was written for the figures and not carried to the labels
    // added after them. Same shape as the clock: the lesson stays where it
    // hurt.
    const mixed = [
      { ...rows[0], cameFromBank: true, enteredByHand: false },
      { ...rows[1], cameFromBank: false, enteredByHand: true },
    ];
    const lines = describeFutureRows(mixed, -12000, 'Card', -10000, -14000);
    const lineWith = (needle: string) => {
      const found = lines.filter((l) => l.includes(needle));
      expect(found, `expected exactly one line containing ${needle}`).toHaveLength(1);
      return found[0];
    };

    expect(lineWith('Farmacia')).toContain('(came from the bank, so the bank counts it)');
    expect(lineWith('Farmacia')).not.toContain('entered here');
    expect(lineWith('rent')).toContain('(entered here, not reconciled)');
    expect(lineWith('rent')).not.toContain('came from the bank');
  });

  it('says nothing extra about a row it cannot place', () => {
    // A cleared row entered here is neither: reconciled in Actual is not the
    // same as posted by the bank, and claiming either would be the mistake the
    // previous labels made.
    expect(text()).not.toMatch(/came from the bank/);
    expect(text()).not.toMatch(/entered here/);
  });

  it('says what booking the wrong one costs', () => {
    expect(text()).toMatch(/reads as currency drift/i);
  });

  it('counts the rows rather than always saying one', () => {
    expect(describeFutureRows([rows[0]], -4000, 'Card', -10000, -14000).join('\n')).toMatch(
      /holds one transaction dated after today/,
    );
    expect(text()).toMatch(/holds 2 transactions dated after today/);
  });
});
