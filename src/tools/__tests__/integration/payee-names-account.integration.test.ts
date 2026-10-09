import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

vi.mock('@actual-app/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@actual-app/api')>();
  return { ...actual, sync: vi.fn().mockResolvedValue(undefined) };
});
vi.mock('../../../connection.js', () => ({
  ensureConnection: vi.fn().mockResolvedValue(undefined),
}));

import { initTestEngine, shutdownTestEngine, createFreshBudget, api } from './actual-engine.js';
import { registerCreateTransaction } from '../../write/create-transaction.js';

const skip = process.env.SKIP_ACTUAL_INTEGRATION === '1';

type Handler = (args: Record<string, unknown>) => Promise<{
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}>;

function handlerFor(register: (s: never) => void): Handler {
  let handler: Handler | undefined;
  register({
    tool: (...a: unknown[]) => {
      handler = a.at(-1) as Handler;
    },
  } as never);
  return handler as Handler;
}

/**
 * A payee that happens to be an account's name (#137).
 *
 * Writing another account's name as the payee is how someone asks for a
 * transfer, and #24 made both sides of it appear. But a prepaid card topped up
 * at a station called "Fuel Station" means there is an account by that name
 * and a shop by that name, and `payee: "Fuel Station", category: "Fuel"` moved
 * money between accounts, dropped the category, and had to be undone by hand.
 *
 * The category decides. Nobody categorises a transfer -- Actual drops it -- so
 * asking for one says the opposite, and it is the only signal that cannot mean
 * both things.
 */
describe.skipIf(skip)('a payee that names an account', () => {
  let card = '';
  let station = '';
  let fuel = '';

  beforeAll(async () => {
    await initTestEngine();
  }, 60_000);

  afterAll(async () => {
    await shutdownTestEngine();
  });

  async function budget(name: string, extra?: () => Promise<void>) {
    await createFreshBudget(async () => {
      card = await api.createAccount({ name: 'Card', offbudget: false } as never, 0);
      station = await api.createAccount({ name: 'Fuel Station', offbudget: false } as never, 0);
      const group = await api.createCategoryGroup({ name: 'Gastos' } as never);
      fuel = await api.createCategory({ name: 'Fuel', group_id: group } as never);
      if (extra) await extra();
    }, name);
  }

  const rows = async (account: string) =>
    api.getTransactions(account, '1900-01-01', '2999-12-31');

  it('records the case from the issue as a purchase, not a transfer', async () => {
    await budget('payee-with-category');
    const create = handlerFor(registerCreateTransaction);

    const result = await create({
      account: 'Card',
      payee: 'Fuel Station',
      category: 'Fuel',
      amount: -20,
      date: '2026-09-10',
    });

    // Checked in the engine, not in the reply.
    const onCard = await rows(card);
    const onStation = await rows(station);

    expect(onCard).toHaveLength(1);
    expect(onCard[0].amount).toBe(-2000);
    // The category asked for survived, which it did not before.
    expect(onCard[0].category).toBe(fuel);
    // And no counterpart: no money moved between accounts.
    expect((onCard[0] as { transfer_id?: string | null }).transfer_id ?? null).toBeNull();
    expect(onStation).toHaveLength(0);

    expect(result.content[0].text).toContain('Transaction created');
    expect(result.content[0].text).not.toContain('Transfer');
  });

  it('still makes a transfer when no category is given (#24)', async () => {
    // The shortcut #24 added, which this must not take away: writing the other
    // account's name is how a transfer is asked for, and both sides appear.
    await budget('payee-without-category');
    const create = handlerFor(registerCreateTransaction);

    const result = await create({
      account: 'Card',
      payee: 'Fuel Station',
      amount: -20,
      date: '2026-09-10',
    });

    const onCard = await rows(card);
    const onStation = await rows(station);

    expect(onCard).toHaveLength(1);
    expect(onStation).toHaveLength(1);
    expect(onStation[0].amount).toBe(2000);
    expect(result.content[0].text).toContain('Transfer created');
  });

  it('says a transfer happened, and that it is not spending', async () => {
    // The caller asked for a payee and got a transfer. In #137 the person did
    // not find out until they went looking for the spending.
    await budget('payee-transfer-notice');
    const create = handlerFor(registerCreateTransaction);

    const text = (
      await create({ account: 'Card', payee: 'Fuel Station', amount: -20, date: '2026-09-10' })
    ).content[0].text;

    expect(text).toContain('Fuel Station is one of your accounts');
    expect(text).toMatch(/not spending/i);
    // And the way out, both of them.
    expect(text).toMatch(/give it a category/i);
  });

  it('says nothing about transfers for an ordinary payee', async () => {
    await budget('ordinary-payee');
    const create = handlerFor(registerCreateTransaction);

    const text = (
      await create({ account: 'Card', payee: 'Colmado', amount: -20, date: '2026-09-10' })
    ).content[0].text;

    expect(text).not.toContain('is also the name of an account');
    expect(text).toContain('Transaction created');
  });

  it('transfers to an off-budget account the same way', async () => {
    // Measured rather than assumed: the comment said "on-budget account" and
    // the code never checked, so this has always worked. It is also correct --
    // moving money to a savings account outside the budget is a transfer --
    // and the notice matters more there, since the money leaves the budget.
    let savings = '';
    await budget('payee-offbudget', async () => {
      savings = await api.createAccount({ name: 'Ahorros', offbudget: true } as never, 0);
    });
    const create = handlerFor(registerCreateTransaction);

    const text = (
      await create({ account: 'Card', payee: 'Ahorros', amount: -20, date: '2026-09-10' })
    ).content[0].text;

    expect(await rows(savings)).toHaveLength(1);
    expect(text).toContain('Transfer created');
    expect(text).toContain('Ahorros is one of your accounts');
    // Not "between your accounts": the money left the budget, which is the
    // point of the account being off budget.
    expect(text).toMatch(/left your budget/i);
    expect(text).not.toMatch(/not spending/i);
  });

  it('keeps the transfer AND the category for an off-budget account', async () => {
    // The case a first version of this fix broke, and it is a real pattern: a
    // category for the contribution and an off-budget account holding the
    // asset. Between two on-budget accounts a category means "not a transfer";
    // to an off-budget one the money leaves the budget, so it is spending and
    // the category is exactly what it wants.
    //
    // Measured in the engine: the category stays on the source row, the
    // counterpart carries none.
    let asset = '';
    await budget('payee-offbudget-with-category', async () => {
      asset = await api.createAccount({ name: 'Investments', offbudget: true } as never, 0);
    });
    const create = handlerFor(registerCreateTransaction);

    const text = (
      await create({
        account: 'Card',
        payee: 'Investments',
        category: 'Fuel',
        amount: -100,
        date: '2026-09-10',
      })
    ).content[0].text;

    const onCard = await rows(card);
    const onAsset = await rows(asset);

    // The counterpart exists: the asset grew.
    expect(onAsset, 'the counterpart is missing').toHaveLength(1);
    expect(onAsset[0].amount).toBe(10000);
    // And the category survived on the source row, where Actual puts it.
    expect(onCard[0].category).toBe(fuel);
    expect((onCard[0] as { transfer_id?: string | null }).transfer_id).toBeTruthy();
    expect(text).toContain('Transfer created');
  });

  describe('all four combinations of on and off budget', () => {
    // The rule applies only when both sides are on budget. Anywhere else the
    // money crosses the budget's edge and the transfer is the point. Two
    // earlier versions got this wrong by looking at one side only.
    const four = [
      { from: false, to: false, label: 'on to on' },
      { from: false, to: true, label: 'on to off' },
      { from: true, to: false, label: 'off to on' },
      { from: true, to: true, label: 'off to off' },
    ];

    const setUp = async (name: string, fromOff: boolean, toOff: boolean) => {
      let source = '';
      let target = '';
      let cat = '';
      await createFreshBudget(async () => {
        source = await api.createAccount({ name: 'Source', offbudget: fromOff } as never, 0);
        target = await api.createAccount({ name: 'Target', offbudget: toOff } as never, 0);
        const group = await api.createCategoryGroup({ name: 'Gastos' } as never);
        cat = await api.createCategory({ name: 'Fuel', group_id: group } as never);
      }, name);
      return { source, target, cat };
    };

    it.each(four)('$label without a category always transfers', async ({ from, to, label }) => {
      const { source, target } = await setUp(`four-${from}-${to}-plain`, from, to);
      const create = handlerFor(registerCreateTransaction);

      await create({ account: 'Source', payee: 'Target', amount: -100, date: '2026-09-10' });

      const onSource = await rows(source);
      const onTarget = await rows(target);
      expect(onSource, label).toHaveLength(1);
      expect(onTarget, `${label}: the counterpart is missing`).toHaveLength(1);
      expect(onTarget[0].amount).toBe(10000);
      expect((onSource[0] as { transfer_id?: string | null }).transfer_id).toBeTruthy();
    }, 60_000);

    it.each(four)('$label with a category', async ({ from, to, label }) => {
      const { source, target, cat } = await setUp(`four-${from}-${to}-cat`, from, to);
      const create = handlerFor(registerCreateTransaction);

      await create({
        account: 'Source',
        payee: 'Target',
        category: 'Fuel',
        amount: -100,
        date: '2026-09-10',
      });

      // Settled, not straight away. Reading immediately is what made #137
      // record `off -> off` as keeping its category: it is there for a moment
      // and then Actual removes it, on that combination only. The note in
      // unsettled-reads.ts has the shape of this; a handful of engine calls
      // closes the window.
      for (let i = 0; i < 6; i += 1) await api.getCategories();

      const onSource = await rows(source);
      const onTarget = await rows(target);
      const bothOnBudget = !from && !to;
      const bothOffBudget = from && to;

      if (bothOnBudget) {
        // The #137 rule: an ordinary purchase, no counterpart, category kept.
        expect(onTarget, `${label}: should not have a counterpart`).toHaveLength(0);
        expect(onSource[0].category, label).toBe(cat);
        expect((onSource[0] as { transfer_id?: string | null }).transfer_id ?? null).toBeNull();
      } else {
        // Money crosses the budget's edge: the transfer is what matters, and
        // both sides must exist or something stops adding up.
        expect(onTarget, `${label}: the counterpart is missing`).toHaveLength(1);
        expect(onTarget[0].amount).toBe(10000);
        expect((onSource[0] as { transfer_id?: string | null }).transfer_id, label).toBeTruthy();
        // Measured through this tool's own path, once the write has settled:
        // the category survives on the row it was asked for, except when
        // neither account is in the budget. There Actual removes it, because
        // nothing could count it, and the reply says so rather than claiming
        // it is stored.
        expect(onSource[0].category ?? null, `${label}: category on the source row`).toBe(
          bothOffBudget ? null : cat,
        );
      }
    }, 60_000);

    it('tells an off-budget source that its category counts nowhere', async () => {
      // The category is kept on that row, and that row is outside the budget.
      // Saying only "kept" would be true and useless.
      await setUp('four-off-on-notice', true, false);
      const create = handlerFor(registerCreateTransaction);

      const text = (
        await create({
          account: 'Source',
          payee: 'Target',
          category: 'Fuel',
          amount: -100,
          date: '2026-09-10',
        })
      ).content[0].text;

      expect(text).toMatch(/came into your budget/i);
      // Kept, but outside the budget, which is the part that matters.
      expect(text).toMatch(/does not count there/i);
      // The old wording, which was false here.
      expect(text).not.toMatch(/inside your budget, so it is not spending/i);
    }, 60_000);

    it('tells two off-budget accounts that the budget is not involved', async () => {
      await setUp('four-off-off-notice', true, true);
      const create = handlerFor(registerCreateTransaction);

      const text = (
        await create({ account: 'Source', payee: 'Target', amount: -100, date: '2026-09-10' })
      ).content[0].text;

      expect(text).toMatch(/does not affect your budget at all/i);
      // Both of the older claims are wrong here.
      expect(text).not.toMatch(/left your budget/i);
      expect(text).not.toMatch(/not spending/i);
    }, 60_000);
  });

  describe('what the reply says about the budget, against the rows', () => {
    // Sixteen cases: four combinations, both signs, with and without a
    // category. The expected wording is derived from the rows the engine
    // wrote, not from the input, because deciding it from the input is what
    // was wrong twice -- the sign flips which way the money ran and the reply
    // went on saying "left your budget" either way.
    const combinations = [
      { from: false, to: false },
      { from: false, to: true },
      { from: true, to: false },
      { from: true, to: true },
    ];
    const cases = combinations.flatMap((c) =>
      [-100, 100].flatMap((amount) =>
        [true, false].map((withCategory) => ({
          ...c,
          amount,
          withCategory,
          label: `${c.from ? 'off' : 'on'}->${c.to ? 'off' : 'on'} ${amount > 0 ? '+' : '-'}100${withCategory ? ' with category' : ''}`,
        })),
      ),
    );

    it.each(cases)('$label', async ({ from, to, amount, withCategory, label }) => {
      let source = '';
      let target = '';
      await createFreshBudget(async () => {
        source = await api.createAccount({ name: 'Source', offbudget: from } as never, 0);
        target = await api.createAccount({ name: 'Target', offbudget: to } as never, 0);
        const group = await api.createCategoryGroup({ name: 'Gastos' } as never);
        await api.createCategory({ name: 'Fuel', group_id: group } as never);
      }, `table-${from}-${to}-${amount}-${withCategory}`);

      const create = handlerFor(registerCreateTransaction);
      const text = (
        await create({
          account: 'Source',
          payee: 'Target',
          amount,
          date: '2026-09-10',
          ...(withCategory ? { category: 'Fuel' } : {}),
        })
      ).content[0].text;

      const onSource = await rows(source);
      const onTarget = await rows(target);

      // Both on budget with a category is the #137 rule: a purchase.
      if (!from && !to && withCategory) {
        expect(onTarget, label).toHaveLength(0);
        expect(text).toContain('Transaction created');
        return;
      }

      // Everything else is a transfer, so read the effect off the rows.
      expect(onSource, label).toHaveLength(1);
      expect(onTarget, `${label}: counterpart missing`).toHaveLength(1);

      const effect =
        (from ? 0 : (onSource[0].amount as number)) + (to ? 0 : (onTarget[0].amount as number));

      if (!from && !to) {
        expect(effect, `${label}: two on-budget rows cancel`).toBe(0);
        expect(text).toMatch(/moved between accounts inside your budget/i);
      } else if (from && to) {
        expect(text).toMatch(/does not affect your budget at all/i);
      } else if (effect > 0) {
        expect(text, `${label}: rows say the money arrived`).toMatch(/came into your budget/i);
        expect(text).not.toMatch(/left your budget/i);
      } else {
        expect(text, `${label}: rows say the money left`).toMatch(/left your budget/i);
        expect(text).not.toMatch(/came into your budget/i);
      }

      // And the direction on the summary line agrees with the sign.
      expect(text).toMatch(
        (onSource[0].amount as number) >= 0 ? /Transfer from: Target/ : /Transfer to: Target/,
      );

      // What it says about the category, from the same rows. It lands on this
      // account's row, so it counts exactly when this account is in the
      // budget -- and saying "it does not count" when it does is as wrong as
      // the direction was.
      if (withCategory && !(from && to)) {
        if (!from) {
          expect(text, `${label}: the category does count here`).toMatch(
            /It counts in Source, under Fuel/,
          );
          expect(text).not.toMatch(/does not count there/i);
        } else {
          expect(text, `${label}: the category counts nowhere here`).toMatch(
            /does not count there/i,
          );
          expect(text).not.toMatch(/It counts in Source/);
        }
      }
    }, 60_000);

    it('tells an off-budget source where to put the category so it counts', async () => {
      // The category stays on the off-budget row, where it counts nowhere.
      // Saying that without saying what to do leaves the person stuck.
      let target = '';
      await createFreshBudget(async () => {
        await api.createAccount({ name: 'Source', offbudget: true } as never, 0);
        target = await api.createAccount({ name: 'Target', offbudget: false } as never, 0);
        const group = await api.createCategoryGroup({ name: 'Gastos' } as never);
        await api.createCategory({ name: 'Fuel', group_id: group } as never);
      }, 'table-off-on-advice');

      const create = handlerFor(registerCreateTransaction);
      const text = (
        await create({
          account: 'Source',
          payee: 'Target',
          category: 'Fuel',
          amount: -100,
          date: '2026-09-10',
        })
      ).content[0].text;

      expect(text).toMatch(/does not count there/i);
      expect(text).toMatch(/set a category on the row in Target/i);
      expect(text).toMatch(/to make this income count/i);
    }, 60_000);
  });

  it('says which way the money went when the amount is positive', async () => {
    // With a positive amount the engine credits this account and debits the
    // other, so the other account is where the money came *from*. Saying "to"
    // describes the opposite of what just happened.
    await budget('payee-transfer-direction');
    const create = handlerFor(registerCreateTransaction);

    const text = (
      await create({ account: 'Card', payee: 'Fuel Station', amount: 70, date: '2026-09-10' })
    ).content[0].text;

    expect((await rows(card))[0].amount).toBe(7000);
    expect((await rows(station))[0].amount).toBe(-7000);
    expect(text).toContain('Transfer from: Fuel Station');
    expect(text).toMatch(/transfer from it/i);
    expect(text).not.toMatch(/Transfer to:/);
  });

  it('names the account even when the payee was given as an id', async () => {
    // Echoing a uuid back as "one of your accounts" tells the reader nothing.
    await budget('payee-id-notice');
    const create = handlerFor(registerCreateTransaction);

    const text = (
      await create({ account: 'Card', payee: station, amount: -20, date: '2026-09-10' })
    ).content[0].text;

    expect(text).toContain('Fuel Station is one of your accounts');
    expect(text).not.toContain(station);
  });

  it('treats a closed account name as an ordinary payee', async () => {
    // The shortcut skips closed accounts, so the name falls through and
    // becomes a payee. That is the right answer -- you cannot transfer into a
    // closed account -- and it keeps working with a category too.
    let old = '';
    await budget('payee-closed', async () => {
      old = await api.createAccount({ name: 'Vieja', offbudget: false } as never, 0);
      await api.closeAccount(old);
    });
    const create = handlerFor(registerCreateTransaction);

    // The fixture has to have actually closed it, or this tests nothing. And
    // what "closed" looks like here is worth writing down: `getAccounts()`
    // leaves closed accounts out entirely rather than returning them with a
    // flag, so the check is that it is gone, not that `closed` is true. An
    // assertion on the flag fails against a correctly closed account.
    const listed = await api.getAccounts();
    expect(listed.map((a) => a.id), 'the account was not closed').not.toContain(old);

    const text = (
      await create({ account: 'Card', payee: 'Vieja', amount: -20, date: '2026-09-10' })
    ).content[0].text;

    expect(text).toContain('Transaction created');
    expect(text).not.toContain('is also the name of an account');
    expect(await rows(old)).toHaveLength(0);
  });

  it('does not treat an account name as a transfer when a category is given, by id either', async () => {
    // The shortcut matches an account id as well as a name, so the rule has to
    // hold for both spellings.
    await budget('payee-by-id-with-category');
    const create = handlerFor(registerCreateTransaction);

    await create({
      account: 'Card',
      payee: station,
      category: 'Fuel',
      amount: -20,
      date: '2026-09-10',
    });

    expect(await rows(station)).toHaveLength(0);
    expect((await rows(card))[0].category).toBe(fuel);
  });
});
