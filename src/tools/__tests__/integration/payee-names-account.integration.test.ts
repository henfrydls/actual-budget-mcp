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

    expect(text).toContain('is also the name of an account');
    expect(text).toContain('Fuel Station');
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
    expect(text).toContain('is also the name of an account');
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
