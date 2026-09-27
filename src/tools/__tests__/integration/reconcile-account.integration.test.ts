import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

vi.mock('@actual-app/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@actual-app/api')>();
  return { ...actual, sync: vi.fn().mockResolvedValue(undefined) };
});

vi.mock('../../../connection.js', () => ({
  ensureConnection: vi.fn().mockResolvedValue(undefined),
}));

import { initTestEngine, shutdownTestEngine, createFreshBudget, api } from './actual-engine.js';
import { registerReconcileAccount } from '../../read/reconcile-account.js';

const skip = process.env.SKIP_ACTUAL_INTEGRATION === '1';

type Handler = (args: Record<string, unknown>) => Promise<{
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}>;

function handlerFor(): Handler {
  let handler: Handler | undefined;
  registerReconcileAccount({
    tool: (...a: unknown[]) => {
      handler = a.at(-1) as Handler;
    },
  } as never);
  return handler as Handler;
}

/**
 * `reconcile_account` (#85) against the real engine.
 *
 * The three cases the issue asks for are here: a balance that agrees, a
 * difference something explains, and a difference nothing explains. The third
 * is the one worth the most, because a candidate search that always finds
 * something is not a candidate search.
 */
describe.skipIf(skip)('reconcile_account against the real engine', () => {
  beforeAll(async () => {
    await initTestEngine();
  }, 60_000);

  afterAll(async () => {
    await shutdownTestEngine();
  });

  /** An account holding a spread of ordinary rows, and a second account. */
  async function budgetWithRows(
    name: string,
    rows: Array<Record<string, unknown>>,
    otherRows: Array<Record<string, unknown>> = [],
  ) {
    let main = '';
    let other = '';
    await createFreshBudget(async () => {
      main = await api.createAccount({ name: 'BHD Nomina', type: 'checking' } as never, 0);
      other = await api.createAccount({ name: 'APAP', type: 'checking' } as never, 0);
      if (rows.length) await api.addTransactions(main, rows as never);
      if (otherRows.length) await api.addTransactions(other, otherRows as never);
    }, name);
    return { main, other };
  }

  const ordinary = [
    { date: '2026-09-01', amount: -125050, payee_name: 'Supermercado', cleared: true },
    { date: '2026-09-03', amount: -48725, payee_name: 'Gasolina', cleared: true },
    { date: '2026-09-05', amount: 4500000, payee_name: 'Salario', cleared: true },
    { date: '2026-09-08', amount: -230075, payee_name: 'Restaurante', cleared: true },
    { date: '2026-09-11', amount: -9925, payee_name: 'Farmacia', cleared: true },
    { date: '2026-09-15', amount: -317840, payee_name: 'Colegio', cleared: true },
  ];
  const ordinaryTotal = ordinary.reduce((s, r) => s + r.amount, 0);

  it('says so when the two figures agree', async () => {
    await budgetWithRows('rec-agree', ordinary);
    const result = await handlerFor()({
      account: 'BHD Nomina',
      expected_balance: ordinaryTotal / 100,
      as_of: '2026-09-25',
    });

    expect(result.isError).toBeFalsy();
    const text = result.content[0].text;
    expect(text).toContain('These agree.');
    expect(text).toContain('Difference:        0.00');
    expect(text).not.toContain('worth looking at');
  }, 60_000);

  it('finds a charge that was entered twice', async () => {
    // The strongest signal: the same payee and amount a few days apart, and
    // dropping one closes the gap exactly.
    const rows = [
      ...ordinary,
      { date: '2026-09-18', amount: -317840, payee_name: 'Colegio', cleared: true },
    ];
    await budgetWithRows('rec-dup', rows);
    const total = rows.reduce((s, r) => s + r.amount, 0);

    // The bank never saw the second one, so it is higher by that amount.
    const result = await handlerFor()({
      account: 'BHD Nomina',
      expected_balance: (total + 317840) / 100,
      as_of: '2026-09-25',
    });

    const text = result.content[0].text;
    expect(text).toContain('looks entered twice');
    expect(text).toContain('Colegio');
  }, 60_000);

  it('warns about a bare amount match when the difference is round', async () => {
    // 45,000.00, a multiple of 100.00. Measured, some row equals a round
    // difference about two times in three when nothing is wrong at all, so
    // this one really is a place to look rather than an answer.
    await budgetWithRows('rec-weak-round', ordinary);

    const result = await handlerFor()({
      account: 'BHD Nomina',
      expected_balance: (ordinaryTotal - 4500000) / 100,
      as_of: '2026-09-25',
    });

    const text = result.content[0].text;
    expect(text).toContain('same amount as the difference');
    expect(text).toContain('Salario');
    expect(text).toContain('two times in three');
  }, 60_000);

  it('does not talk a good lead down when the difference is not round', async () => {
    // 99.25. Measured on the same generated accounts, a difference with
    // centavos is matched by chance essentially never, so an exact match on
    // one is a strong lead. The warning written for round differences was
    // being said about these too, arguing the reader out of the best thing on
    // the page.
    await budgetWithRows('rec-weak-odd', ordinary);

    const result = await handlerFor()({
      account: 'BHD Nomina',
      expected_balance: (ordinaryTotal + 9925) / 100,
      as_of: '2026-09-25',
    });

    const text = result.content[0].text;
    expect(text).toContain('Farmacia');
    expect(text).not.toContain('two times in three');
    expect(text).toContain('Worth chasing');
  }, 60_000);

  it('says the window it looked at even when it found something', async () => {
    // The hint used to live only on the empty branch, so the case where it
    // matters most never carried it: a weak decoy inside the window while the
    // real answer sits outside it.
    await budgetWithRows('rec-window-hint', ordinary);

    const result = await handlerFor()({
      account: 'BHD Nomina',
      expected_balance: (ordinaryTotal + 9925) / 100,
      as_of: '2026-09-25',
    });

    const text = result.content[0].text;
    expect(text).toContain('worth looking at');
    expect(text).toContain('raise lookback_days');
  }, 60_000);

  it('puts the rarer signal above the weaker one', async () => {
    // Both kinds at once, which is the only way to check the order without the
    // assertion passing because one of them is absent. The difference is
    // +888.00: a row of -888.00 here is a bare amount match, and a row of
    // +888.00 on another account is the rarer signal.
    await budgetWithRows(
      'rec-order',
      [...ordinary, { date: '2026-09-10', amount: -88800, payee_name: 'Weak', cleared: true }],
      [{ date: '2026-09-10', amount: 88800, payee_name: 'Elsewhere', cleared: true }],
    );

    const total = ordinaryTotal - 88800;
    const result = await handlerFor()({
      account: 'BHD Nomina',
      expected_balance: (total + 88800) / 100,
      as_of: '2026-09-25',
    });

    const text = result.content[0].text;
    const rare = text.indexOf('this amount is on APAP');
    const weak = text.indexOf('same amount as the difference');
    expect(rare).toBeGreaterThan(-1);
    expect(weak).toBeGreaterThan(-1);
    expect(rare).toBeLessThan(weak);
  }, 60_000);

  it('finds the amount sitting on another account', async () => {
    // Entering a movement against the wrong account looks exactly like this
    // from here: the balance is short by it, and it is somewhere else.
    await budgetWithRows('rec-wrong-acct', ordinary, [
      { date: '2026-09-09', amount: -88800, payee_name: 'Seguro', cleared: true },
    ]);

    const result = await handlerFor()({
      account: 'BHD Nomina',
      expected_balance: (ordinaryTotal - 88800) / 100,
      as_of: '2026-09-25',
    });

    const text = result.content[0].text;
    expect(text).toContain('this amount is on APAP');
    expect(text).toContain('Seguro');
  }, 60_000);

  it('finds a row dated past the cutoff', async () => {
    await budgetWithRows('rec-after', [
      ...ordinary,
      { date: '2026-09-28', amount: -55500, payee_name: 'Internet', cleared: true },
    ]);

    // The bank counts it; the balance to the cutoff does not.
    const result = await handlerFor()({
      account: 'BHD Nomina',
      expected_balance: (ordinaryTotal - 55500) / 100,
      as_of: '2026-09-25',
    });

    const text = result.content[0].text;
    expect(text).toContain('dated after the cutoff');
    expect(text).toContain('Internet');
  }, 60_000);

  it('finds nothing, and says so, when nothing explains the difference', async () => {
    // The case that matters most. The account is full of ordinary rows and the
    // difference is an odd figure that none of them, and no pair of them,
    // matches. A search that reported something here would be reporting noise.
    await budgetWithRows('rec-nothing', ordinary);

    const result = await handlerFor()({
      account: 'BHD Nomina',
      expected_balance: (ordinaryTotal - 13742) / 100,
      as_of: '2026-09-25',
    });

    const text = result.content[0].text;
    expect(text).toContain('Nothing here explains it.');
    expect(text).toContain('Looked at 6 transactions between 2026-06-27 and 2026-09-25');
    expect(text).not.toContain('worth looking at');
    // And it still reports the difference, which is the half it can answer.
    expect(text).toContain('137.42');
  }, 60_000);

  it('counts uncleared rows by default and drops them when asked', async () => {
    // #108: on the budget this was measured against, uncleared meant nobody
    // ticked it off, not that the bank had not posted it, so counting them is
    // the default.
    await budgetWithRows('rec-cleared', [
      { date: '2026-09-01', amount: -1000, cleared: true },
      { date: '2026-09-02', amount: -2000, cleared: false },
    ]);

    const both = await handlerFor()({
      account: 'BHD Nomina',
      expected_balance: -30,
      as_of: '2026-09-25',
    });
    expect(both.content[0].text).toContain('This budget says:  -30.00');
    expect(both.content[0].text).toContain('These agree.');

    const clearedOnly = await handlerFor()({
      account: 'BHD Nomina',
      expected_balance: -30,
      as_of: '2026-09-25',
      balance_counts: 'cleared_only',
    });
    const text = clearedOnly.content[0].text;
    // The whole line. Asserting just "-10.00" passed with the balance wrong,
    // because the difference line happened to read -10.00 as well: the figure
    // was being checked against the wrong row of the reply.
    expect(text).toContain('This budget says:  -10.00   (cleared rows only)');
  }, 60_000);

  it('does not offer a row from this very account as being on another one', async () => {
    // Without excluding the account being reconciled, its own rows come back
    // from the same-amount lookup and the reply says the amount is on the
    // account you are already looking at.
    await budgetWithRows('rec-self', [
      ...ordinary,
      { date: '2026-09-12', amount: 77700, payee_name: 'Reembolso', cleared: true },
    ]);

    const result = await handlerFor()({
      account: 'BHD Nomina',
      expected_balance: (ordinaryTotal + 77700 + 77700) / 100,
      as_of: '2026-09-25',
    });

    const text = result.content[0].text;
    expect(text).not.toContain('this amount is on BHD Nomina');
  }, 60_000);

  it('does not call a recurring payment a duplicate', async () => {
    // The false positive that matters most here: rent, school fees, a
    // subscription. Same payee, same amount, every month. Without the
    // seven-day window every one of them is reported as entered twice, on
    // every account that has a standing payment, which is most of them.
    await budgetWithRows('rec-recurring', [
      { date: '2026-07-05', amount: -2500000, payee_name: 'Alquiler', cleared: true },
      { date: '2026-08-05', amount: -2500000, payee_name: 'Alquiler', cleared: true },
      { date: '2026-09-05', amount: -2500000, payee_name: 'Alquiler', cleared: true },
    ]);

    const result = await handlerFor()({
      account: 'BHD Nomina',
      expected_balance: (-2500000 * 3 + 2500000) / 100,
      as_of: '2026-09-25',
    });

    const text = result.content[0].text;
    expect(text).not.toContain('looks entered twice');
    // It is still worth showing as the weak signal it is.
    expect(text).toContain('same amount as the difference');
  }, 60_000);

  it('counts to the cutoff and not to today', async () => {
    // #100 and #103 again: without the cutoff, `getAccountBalance` uses its own
    // `new Date()`. Dates here are relative to today so that the gap between
    // as_of and now always exists, rather than only while the fixture is young.
    const day = (back: number) =>
      new Date(Date.now() - back * 86_400_000).toISOString().slice(0, 10);

    await budgetWithRows('rec-cutoff', [
      { date: day(20), amount: -100000, payee_name: 'Antes', cleared: true },
      // Between as_of and today: counted only if the cutoff is ignored.
      { date: day(2), amount: -70000, payee_name: 'Despues', cleared: true },
    ]);

    const result = await handlerFor()({
      account: 'BHD Nomina',
      expected_balance: -1000,
      as_of: day(5),
    });

    const text = result.content[0].text;
    expect(text).toContain('This budget says:  -1,000.00');
    expect(text).toContain('These agree.');
  }, 60_000);

  it('offers nothing when the balance agrees, even with a zero-amount row', async () => {
    // A zero difference has nothing to explain, and every amount filter would
    // match a zero-amount row. Those exist: corrections and placeholders.
    await budgetWithRows('rec-zero', [
      ...ordinary,
      { date: '2026-09-14', amount: 0, payee_name: 'Ajuste', cleared: true },
    ]);

    const result = await handlerFor()({
      account: 'BHD Nomina',
      expected_balance: ordinaryTotal / 100,
      as_of: '2026-09-25',
    });

    const text = result.content[0].text;
    expect(text).toContain('These agree.');
    expect(text).not.toContain('Ajuste');
  }, 60_000);

  it('gets the direction right in both directions', async () => {
    await budgetWithRows('rec-signs', ordinary);
    const handler = handlerFor();

    const bankHigher = await handler({
      account: 'BHD Nomina',
      expected_balance: (ordinaryTotal + 50000) / 100,
      as_of: '2026-09-25',
    });
    expect(bankHigher.content[0].text).toContain('The bank is higher by 500.00');

    const bankLower = await handler({
      account: 'BHD Nomina',
      expected_balance: (ordinaryTotal - 50000) / 100,
      as_of: '2026-09-25',
    });
    expect(bankLower.content[0].text).toContain('The bank is lower by 500.00');
  }, 60_000);
});
