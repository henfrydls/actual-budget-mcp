import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fakeQ } from '../../tools/__tests__/fake-query.js';

vi.mock('@actual-app/api', () => ({
  default: {},
  runQuery: vi.fn(),
  getPayees: vi.fn().mockResolvedValue([{ id: 'p1', name: 'Colmado' }]),
  getAccounts: vi.fn().mockResolvedValue([
    { id: 'acc-1', name: 'BHD Nomina' },
    { id: 'acc-2', name: 'APAP' },
  ]),
  q: (table: string) => fakeQ(table),
  utils: {
    amountToInteger: (a: number) => Math.round(a * 100),
    integerToAmount: (c: number) => c / 100,
  },
}));

import * as api from '@actual-app/api';
import { findReconcileCandidates } from '../reconcile-candidates.js';

/**
 * The module behind `reconcile_account`, tested where the tool cannot reach.
 *
 * The tool answers a zero difference before it reads any of this, so the guard
 * against a zero difference is unreachable through it. That is the shape of
 * code that looks like a protection and is not one, so it is exercised here
 * directly rather than left to be assumed.
 */
describe('findReconcileCandidates', () => {
  beforeEach(() => {
    vi.mocked(api.runQuery).mockReset();
  });

  /** In-window rows, after-cutoff rows, then anything else the code asks for. */
  function answers(inWindow: unknown[], afterCutoff: unknown[] = [], elsewhere: unknown[] = []) {
    vi.mocked(api.runQuery)
      .mockResolvedValueOnce({ data: inWindow } as never)
      .mockResolvedValueOnce({ data: afterCutoff } as never)
      .mockResolvedValue({ data: elsewhere } as never);
  }

  it('offers nothing for a zero difference, and does not go looking', async () => {
    // A zero-amount row matches every amount filter, and rows like it exist:
    // corrections and placeholders. Without the guard it comes back as a
    // candidate explaining a difference that is not there.
    answers([{ id: 't1', date: '2026-09-14', amount: 0, cleared: true }]);

    const report = await findReconcileCandidates('acc-1', '2026-09-25', 0, 90);

    expect(report.candidates).toEqual([]);
    // Two reads: the window and past the cutoff, both needed for the context
    // the reply prints. The third, which looks at other accounts, is work with
    // nothing to find.
    expect(vi.mocked(api.runQuery)).toHaveBeenCalledTimes(2);
  });

  it('reads the signs the right way round', async () => {
    // difference = expected - actual. Positive means the bank is higher, so a
    // row *here* that should not be is a negative one of that size. Getting
    // this backwards is the easiest mistake in the module and the hardest to
    // see, because both directions produce a plausible-looking answer.
    answers(
      [
        { id: 'here', date: '2026-09-10', amount: -50000, payee: 'p1', cleared: true },
        { id: 'wrong-sign', date: '2026-09-11', amount: 50000, payee: 'p1', cleared: true },
      ],
      [],
      [],
    );

    const report = await findReconcileCandidates('acc-1', '2026-09-25', 50000, 90);

    expect(report.candidates.map((c) => c.id)).toEqual(['here']);
    expect(report.candidates[0].kind).toBe('amount_match');
  });

  it('reports the window it looked at, for the reply to state', async () => {
    answers([
      { id: 'a', date: '2026-09-01', amount: -100, cleared: true },
      { id: 'b', date: '2026-09-02', amount: -200, cleared: false },
    ]);

    const report = await findReconcileCandidates('acc-1', '2026-09-25', 12345, 30);

    expect(report.rowsExamined).toBe(2);
    expect(report.unclearedCount).toBe(1);
    expect(report.to).toBe('2026-09-25');
    expect(report.from).toBe('2026-08-26');
  });
});
