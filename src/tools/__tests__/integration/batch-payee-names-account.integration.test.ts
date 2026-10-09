import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

vi.mock('@actual-app/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@actual-app/api')>();
  return { ...actual, sync: vi.fn().mockResolvedValue(undefined) };
});
vi.mock('../../../connection.js', () => ({
  ensureConnection: vi.fn().mockResolvedValue(undefined),
}));

import { initTestEngine, shutdownTestEngine, createFreshBudget, api } from './actual-engine.js';
import { createTransactions } from '../../write/create-transactions.js';

const skip = process.env.SKIP_ACTUAL_INTEGRATION === '1';

/**
 * A payee that names an account, in a batch (#154).
 *
 * `create_transaction` has made these transfers since #24, with the category
 * rule from #137 on top. The batch refused them and sent the caller to
 * `create_transfer`, saying a batch could not mix transfers with ordinary
 * rows. It can, so the rule is shared now and this is the table that says both
 * tools answer the same.
 *
 * The expectations are read off the rows in the engine rather than off the
 * reply: a reply that describes a transfer it did not make is exactly the
 * failure worth catching.
 */
interface Case {
  /** What the row asks for. */
  readonly label: string;
  readonly from: 'Checking' | 'Savings' | 'Invest' | 'Loan';
  readonly to: 'Checking' | 'Savings' | 'Invest' | 'Loan';
  readonly amount: number;
  readonly category?: string;
  readonly date: string;
  /** What the engine should end up holding. */
  readonly isTransfer: boolean;
  /** The word the summary should use for it, when it is a transfer. */
  readonly effect?: 'inside your budget' | 'left your budget' | 'came into your budget' | 'outside your budget';
  /** Whether the category asked for is still on the row afterwards. */
  readonly keepsCategory: boolean;
  /** A positive amount: the money came from the other account. */
  readonly arrives?: boolean;
}

const CASES: readonly Case[] = [
  // on -> on. The only combination where a category means "not a transfer":
  // between two budgeted accounts the money has not left the budget.
  { label: 'on to on, no category', from: 'Checking', to: 'Savings', amount: -10, date: '2026-09-01', isTransfer: true, effect: 'inside your budget', keepsCategory: false },
  { label: 'on to on, with a category', from: 'Checking', to: 'Savings', amount: -20, category: 'Comida', date: '2026-09-02', isTransfer: false, keepsCategory: true },

  // on -> off. Money crossing the edge of the budget, so it stays a transfer
  // whatever the category says.
  { label: 'on to off, no category', from: 'Checking', to: 'Invest', amount: -30, date: '2026-09-03', isTransfer: true, effect: 'left your budget', keepsCategory: false },
  { label: 'on to off, with a category', from: 'Checking', to: 'Invest', amount: -40, category: 'Comida', date: '2026-09-04', isTransfer: true, effect: 'left your budget', keepsCategory: true },

  // off -> on. The same crossing in the other direction, which an earlier
  // version of the single-row rule got wrong by looking only at the target.
  { label: 'off to on, no category', from: 'Invest', to: 'Checking', amount: -50, date: '2026-09-05', isTransfer: true, effect: 'came into your budget', keepsCategory: false },
  { label: 'off to on, with a category', from: 'Invest', to: 'Checking', amount: -60, category: 'Comida', date: '2026-09-06', isTransfer: true, effect: 'came into your budget', keepsCategory: true },

  // off -> off. Neither side is in the budget, so nothing counts anywhere.
  { label: 'off to off, no category', from: 'Invest', to: 'Loan', amount: -70, date: '2026-09-07', isTransfer: true, effect: 'outside your budget', keepsCategory: false },
  { label: 'off to off, with a category', from: 'Invest', to: 'Loan', amount: -80, category: 'Comida', date: '2026-09-08', isTransfer: true, effect: 'outside your budget', keepsCategory: false },

  // Money arriving, which is where the direction can be got backwards. A
  // positive amount means the other account is where it came from, and reading
  // it off the argument instead of the sign says the opposite: #137 made that
  // mistake twice before the rule was written from the rows.
  { label: 'money arriving from another budgeted account', from: 'Checking', to: 'Savings', amount: 500, date: '2026-09-11', isTransfer: true, effect: 'inside your budget', keepsCategory: false, arrives: true },
  { label: 'money arriving from off budget', from: 'Checking', to: 'Invest', amount: 700, date: '2026-09-12', isTransfer: true, effect: 'came into your budget', keepsCategory: false, arrives: true },
];

describe.skipIf(skip)('a batch with payees that name accounts', () => {
  const id: Record<string, string> = {};
  let comida = '';
  let reply = '';

  beforeAll(async () => {
    await initTestEngine();

    await createFreshBudget(async () => {
      id.Checking = await api.createAccount({ name: 'Checking', offbudget: false } as never, 0);
      id.Savings = await api.createAccount({ name: 'Savings', offbudget: false } as never, 0);
      id.Invest = await api.createAccount({ name: 'Invest', offbudget: true } as never, 0);
      id.Loan = await api.createAccount({ name: 'Loan', offbudget: true } as never, 0);
      const group = await api.createCategoryGroup({ name: 'Gastos' } as never);
      comida = await api.createCategory({ name: 'Comida', group_id: group } as never);
    }, 'batch-transfer-table');

    // One call, every combination in it, and two ordinary rows alongside:
    // the mix is the thing that used to be refused.
    const lines = await createTransactions({
      transactions: [
        ...CASES.map((c) => ({
          account: c.from,
          amount: c.amount,
          payee: c.to,
          category: c.category,
          date: c.date,
        })),
        { account: 'Checking', amount: -90, payee: 'Supermercado', category: 'Comida', date: '2026-09-09', imported_id: 'bank-90' },
        { account: 'Savings', amount: -100, payee: 'Cafe', date: '2026-09-10' },
      ],
    });
    reply = lines.join('\n');

    // Settled before anything is read. Reading straight after the write is
    // what made #137 record `off -> off` as keeping its category: it is there
    // for a moment and then Actual removes it. See unsettled-reads.ts.
    for (let i = 0; i < 6; i += 1) await api.getCategories();
  }, 120_000);

  afterAll(async () => {
    await shutdownTestEngine();
  });

  const rowOn = async (account: string, date: string) => {
    const rows = (await api.getTransactions(id[account], '1900-01-01', '2999-12-31')) as Array<
      Record<string, unknown>
    >;
    return rows.find((r) => r.date === date);
  };

  it('wrote the whole batch, transfers and ordinary rows together', () => {
    expect(reply).toContain(`Created ${CASES.length + 2} transactions.`);
  });

  for (const c of CASES) {
    it(`${c.label}: ${c.isTransfer ? 'becomes a transfer' : 'stays an ordinary row'}`, async () => {
      const source = await rowOn(c.from, c.date);
      expect(source, `no row on ${c.from} for ${c.date}`).toBeDefined();
      expect(source!.amount).toBe(c.amount * 100);

      const linked = (source as { transfer_id?: string | null }).transfer_id ?? null;
      const counterpart = await rowOn(c.to, c.date);

      if (!c.isTransfer) {
        expect(linked, 'got a counterpart it should not have').toBeNull();
        expect(counterpart, 'the other account got a row').toBeUndefined();
        expect(source!.category, 'the category was dropped').toBe(comida);
        return;
      }

      expect(linked, 'no counterpart was created').not.toBeNull();
      expect(counterpart, `nothing landed on ${c.to}`).toBeDefined();
      expect(counterpart!.amount).toBe(-c.amount * 100);

      // The category lives on the row it was asked for, except between two
      // off-budget accounts, where Actual removes it because nothing could
      // count it. Same as the single-row tool, measured the same way.
      expect(source!.category).toBe(c.keepsCategory ? comida : null);
    });
  }

  it('leaves the ordinary rows alone in the same call', async () => {
    // With `runTransfers` on for the account's group, which is what used to be
    // the reason for refusing the batch.
    const shop = await rowOn('Checking', '2026-09-09');
    expect((shop as { transfer_id?: string | null }).transfer_id ?? null).toBeNull();
    expect(shop!.category).toBe(comida);
    expect(shop!.imported_id).toBe('bank-90');

    const cafe = await rowOn('Savings', '2026-09-10');
    expect((cafe as { transfer_id?: string | null }).transfer_id ?? null).toBeNull();
  });

  it('names every transfer in the summary, with its direction', () => {
    for (const c of CASES.filter((x) => x.isTransfer)) {
      const index = CASES.indexOf(c) + 1;
      // The arrow follows the money, which the sign decides: a positive
      // amount is money arriving, so the other account is where it came from.
      expect(reply, `row ${index} is missing from the summary`).toContain(
        c.arrives ? `row ${index}  ${c.to} -> ${c.from}` : `row ${index}  ${c.from} -> ${c.to}`,
      );
    }
  });

  it('does not list the row that stayed ordinary', () => {
    const index = CASES.findIndex((c) => !c.isTransfer) + 1;
    expect(reply).not.toContain(`row ${index}  `);
  });

  it('labels each transfer with what it did to the budget', () => {
    for (const c of CASES.filter((x) => x.isTransfer)) {
      const index = CASES.indexOf(c) + 1;
      const line = reply.split('\n').find((l) => l.includes(`row ${index}  `));
      expect(line, `row ${index} has no summary line`).toBeDefined();
      expect(line, `row ${index} is labelled wrong`).toContain(c.effect!);
    }
  });

  it('explains each kind once, however many rows earned it', () => {
    // Two rows of every kind, and the paragraph is the part that would be
    // unreadable repeated: twenty transfers would print it twenty times.
    const occurrences = (needle: string) => reply.split(needle).length - 1;

    expect(occurrences('Inside your budget means')).toBe(1);
    expect(occurrences('Left your budget means')).toBe(1);
    expect(occurrences('Came into your budget means')).toBe(1);
    expect(occurrences('Outside your budget means')).toBe(1);
  });

  it('says where the category counts, once, when a crossing row has one', () => {
    expect(reply.split('The category on a row that crossed the edge').length - 1).toBe(1);
  });

  it('does not claim a category it no longer has', () => {
    // The row between two off-budget accounts asked for a category and does
    // not have one. Telling the reader it is stored there would send them
    // looking for something the engine removed.
    expect(reply).toMatch(/was not kept/);
    expect(reply.split('not kept').length - 1).toBe(1);
  });
});

/**
 * The month this is for, in the shape it actually arrives.
 *
 * A month of records is one batch: the card spending, the payment that clears
 * the card, and the standing contribution that leaves the budget for an asset
 * account. Before this, the two movements between accounts had to be pulled
 * out of the list and sent one at a time through `create_transfer`, which is
 * the afternoon #154 is about. The amounts and the shape are a real month's,
 * with the names changed.
 */
describe.skipIf(skip)('a month of records in one batch', () => {
  const id: Record<string, string> = {};
  let reply = '';
  let inversion = '';

  beforeAll(async () => {
    await initTestEngine();
    await createFreshBudget(async () => {
      id.Nomina = await api.createAccount({ name: 'Nomina', offbudget: false } as never, 0);
      id.Tarjeta = await api.createAccount({ name: 'Tarjeta', offbudget: false } as never, 0);
      // The asset the monthly contribution builds up. Off budget, because the
      // money is still his and should not read as spending.
      id.Inversion = await api.createAccount({ name: 'Inversion Familiar', offbudget: true } as never, 0);
      const group = await api.createCategoryGroup({ name: 'Gastos' } as never);
      await api.createCategory({ name: 'Supermercado', group_id: group } as never);
      inversion = await api.createCategory({ name: 'Inversion Familiar', group_id: group } as never);
    }, 'batch-real-month');

    const lines = await createTransactions({
      transactions: [
        { account: 'Tarjeta', amount: -4280.5, payee: 'Supermercado Nacional', category: 'Supermercado', date: '2026-09-03' },
        { account: 'Tarjeta', amount: -1950, payee: 'Supermercado Bravo', category: 'Supermercado', date: '2026-09-11' },
        // Paying the card off: money moving between two budgeted accounts, so
        // it is not spending and must not be counted twice.
        { account: 'Nomina', amount: -6230.5, payee: 'Tarjeta', date: '2026-09-25' },
        // The contribution, which leaves the budget and is categorised.
        { account: 'Nomina', amount: -5000, payee: 'Inversion Familiar', category: 'Inversion Familiar', date: '2026-09-10' },
      ],
    });
    reply = lines.join('\n');
    for (let i = 0; i < 6; i += 1) await api.getCategories();
  }, 120_000);

  afterAll(async () => {
    await shutdownTestEngine();
  });

  it('writes all four rows in the one call', () => {
    expect(reply).toContain('Created 4 transactions.');
  });

  it('pays the card off without calling it spending', async () => {
    const rows = (await api.getTransactions(id.Nomina, '1900-01-01', '2999-12-31')) as Array<
      Record<string, unknown>
    >;
    const payment = rows.find((r) => r.date === '2026-09-25');
    expect((payment as { transfer_id?: string | null }).transfer_id ?? null).not.toBeNull();
    expect(payment!.category, 'a card payment is not spending').toBeNull();
    expect(reply).toContain('inside your budget');
  });

  it('keeps the contribution out of the budget, with its category', async () => {
    const rows = (await api.getTransactions(id.Nomina, '1900-01-01', '2999-12-31')) as Array<
      Record<string, unknown>
    >;
    const contribution = rows.find((r) => r.date === '2026-09-10');
    expect((contribution as { transfer_id?: string | null }).transfer_id ?? null).not.toBeNull();
    // On budget on this side, so the category counts here.
    expect(contribution!.category).toBe(inversion);

    const asset = (await api.getTransactions(id.Inversion, '1900-01-01', '2999-12-31')) as Array<
      Record<string, unknown>
    >;
    expect(asset).toHaveLength(1);
    expect(asset[0].amount).toBe(500000);
    expect(reply).toContain('left your budget');
  });

  it('leaves the two card purchases alone', async () => {
    const rows = (await api.getTransactions(id.Tarjeta, '1900-01-01', '2999-12-31')) as Array<
      Record<string, unknown>
    >;
    const purchases = rows.filter((r) => r.date === '2026-09-03' || r.date === '2026-09-11');
    expect(purchases).toHaveLength(2);
    for (const row of purchases) {
      expect((row as { transfer_id?: string | null }).transfer_id ?? null).toBeNull();
      expect(row.category, 'a purchase lost its category').not.toBeNull();
    }
  });

  it('names both movements between accounts, and only those', () => {
    expect(reply).toContain('row 3  Nomina -> Tarjeta');
    expect(reply).toContain('row 4  Nomina -> Inversion Familiar');
    expect(reply).not.toContain('row 1  ');
    expect(reply).not.toContain('row 2  ');
  });
});

/**
 * The checks a transfer row still has to pass (#147, #155).
 *
 * Making these rows legal must not make them exempt. A transfer is still a row
 * in an account on a date for an amount, and resending a list is still the
 * thing that duplicates a month of records.
 */
describe.skipIf(skip)('a transfer row is still checked like any other', () => {
  let checking = '';
  let savings = '';

  beforeAll(async () => {
    await initTestEngine();
  }, 60_000);

  afterAll(async () => {
    await shutdownTestEngine();
  });

  async function budget(name: string) {
    await createFreshBudget(async () => {
      checking = await api.createAccount({ name: 'Checking', offbudget: false } as never, 0);
      savings = await api.createAccount({ name: 'Savings', offbudget: false } as never, 0);
    }, name);
  }

  const count = async (acct: string) =>
    (await api.getTransactions(acct, '1900-01-01', '2999-12-31')).length;

  it('refuses the same transfer twice in one list', async () => {
    await budget('batch-transfer-twice');
    const before = await count(checking);

    const lines = await createTransactions({
      transactions: [
        { account: 'Checking', amount: -500, payee: 'Savings', date: '2026-09-02' },
        { account: 'Checking', amount: -500, payee: 'Savings', date: '2026-09-02' },
      ],
    });

    expect(await count(checking), 'nothing should have been written').toBe(before);
    expect(lines.join('\n')).toContain('repeats row 1');
  }, 60_000);

  it('refuses a transfer the budget already has, so resending a month is safe', async () => {
    await budget('batch-transfer-resend');

    await createTransactions({
      transactions: [
        { account: 'Checking', amount: -10, payee: 'Shop', date: '2026-09-01' },
        { account: 'Checking', amount: -500, payee: 'Savings', date: '2026-09-02' },
      ],
    });
    const afterFirst = await count(checking);

    const lines = await createTransactions({
      transactions: [
        { account: 'Checking', amount: -10, payee: 'Shop', date: '2026-09-01' },
        { account: 'Checking', amount: -500, payee: 'Savings', date: '2026-09-02' },
      ],
    });

    expect(await count(checking), 'the second send wrote something').toBe(afterFirst);
    expect(lines.join('\n')).toContain('Nothing was created');
  }, 60_000);

  it('keeps a bank id on a transfer row, and refuses it a second time', async () => {
    // #147: the id is identity, and `allow_duplicate` does not reach it. A
    // transfer carrying one is still that movement.
    await budget('batch-transfer-imported');

    await createTransactions({
      transactions: [
        { account: 'Checking', amount: -500, payee: 'Savings', date: '2026-09-02', imported_id: 'bank-t1' },
      ],
    });
    for (let i = 0; i < 6; i += 1) await api.getCategories();

    const rows = (await api.getTransactions(checking, '1900-01-01', '2999-12-31')) as Array<
      Record<string, unknown>
    >;
    const written = rows.find((r) => r.date === '2026-09-02');
    expect(written!.imported_id, 'the bank id was dropped on a transfer').toBe('bank-t1');
    expect((written as { transfer_id?: string | null }).transfer_id ?? null).not.toBeNull();

    const again = await createTransactions({
      transactions: [
        { account: 'Checking', amount: -500, payee: 'Savings', date: '2026-09-05', imported_id: 'bank-t1' },
      ],
      allow_duplicate: true,
    });

    expect(again.join('\n')).toContain('has been recorded before');
  }, 60_000);
});
