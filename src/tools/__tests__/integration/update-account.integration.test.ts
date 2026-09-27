import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

vi.mock('@actual-app/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@actual-app/api')>();
  return { ...actual, sync: vi.fn().mockResolvedValue(undefined) };
});

vi.mock('../../../connection.js', () => ({
  ensureConnection: vi.fn().mockResolvedValue(undefined),
}));

import { initTestEngine, shutdownTestEngine, createFreshBudget, api } from './actual-engine.js';
import { registerUpdateAccount } from '../../write/update-account.js';

const skip = process.env.SKIP_ACTUAL_INTEGRATION === '1';

type Handler = (args: Record<string, unknown>) => Promise<{
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}>;

function handlerFor(): Handler {
  let handler: Handler | undefined;
  registerUpdateAccount({
    tool: (...a: unknown[]) => {
      handler = a.at(-1) as Handler;
    },
  } as never);
  return handler as Handler;
}

/**
 * `update_account` (#87) against the real engine.
 *
 * The issue's criterion is that transactions and balance are untouched, so
 * those are read before and after rather than inferred from the new name
 * coming back.
 */
describe.skipIf(skip)('update_account', () => {
  let onBudget = '';
  let offBudget = '';

  async function budget(name: string) {
    await createFreshBudget(async () => {
      onBudget = await api.createAccount(
        { name: 'BHD Nomina', offbudget: false } as never,
        50000,
      );
      offBudget = await api.createAccount(
        { name: 'Inversion', offbudget: true } as never,
        900000,
      );
      await api.addTransactions(onBudget, [
        { date: '2026-09-05', amount: -12345, cleared: true },
        { date: '2026-09-06', amount: -6789, cleared: true },
      ] as never);
    }, name);
  }

  async function stateOf(id: string) {
    const account = (await api.getAccounts()).find((a) => a.id === id);
    return {
      name: account?.name,
      offbudget: (account as { offbudget?: boolean } | undefined)?.offbudget,
      closed: (account as { closed?: boolean } | undefined)?.closed,
      balance: await api.getAccountBalance(id),
      transactions: (await api.getTransactions(id, '1900-01-01', '2999-12-31')).length,
    };
  }

  beforeAll(async () => {
    await initTestEngine();
  }, 60_000);

  afterAll(async () => {
    await shutdownTestEngine();
  });

  it('renames without touching the transactions or the balance', async () => {
    await budget('acct-rename');
    const before = await stateOf(onBudget);
    expect(before.transactions).toBe(3);

    const result = await handlerFor()({ account: 'BHD Nomina', name: 'BHD Nomina DOP' });

    expect(result.isError).toBeFalsy();
    const after = await stateOf(onBudget);

    expect(after.name).toBe('BHD Nomina DOP');
    expect(after.balance).toBe(before.balance);
    expect(after.transactions).toBe(before.transactions);
    expect(result.content[0].text).toContain('Renamed "BHD Nomina" to "BHD Nomina DOP"');
  }, 60_000);

  it('leaves the budget status alone, on and off budget', async () => {
    // A naive `updateAccount({ id, name })` could reset the other columns.
    // Measured that it does not, and pinned so a change upstream says so.
    await budget('acct-status');
    const handler = handlerFor();

    await handler({ account: 'BHD Nomina', name: 'Nomina' });
    await handler({ account: 'Inversion', name: 'Inversion ASOTRAPUSA' });

    const on = await stateOf(onBudget);
    const off = await stateOf(offBudget);

    expect(on.offbudget).toBe(false);
    expect(on.closed).toBe(false);
    expect(off.offbudget).toBe(true);
    expect(off.closed).toBe(false);
    expect(off.balance).toBe(900000);
  }, 60_000);

  it('says nothing changed when the name is already that', async () => {
    await budget('acct-noop');

    const result = await handlerFor()({ account: 'BHD Nomina', name: 'BHD Nomina' });

    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain('already called that');
    expect((await stateOf(onBudget)).name).toBe('BHD Nomina');
  }, 60_000);

  it('refuses an empty name instead of leaving the account unnamed', async () => {
    // Measured: the engine accepts '' and the account ends up with no name.
    await budget('acct-empty');

    for (const name of ['', '   ']) {
      const result = await handlerFor()({ account: 'BHD Nomina', name });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('empty name');
      expect((await stateOf(onBudget)).name).toBe('BHD Nomina');
    }
  }, 60_000);

  it('refuses a name another account already has', async () => {
    // Actual allows two accounts to share a name, and then neither can be
    // resolved by it. Measured: a second account called "Ahorro" was created
    // without complaint.
    await budget('acct-clash');

    const result = await handlerFor()({ account: 'BHD Nomina', name: 'Inversion' });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('already called "Inversion"');
    expect((await stateOf(onBudget)).name).toBe('BHD Nomina');
    expect((await stateOf(offBudget)).name).toBe('Inversion');
  }, 60_000);

  it('refuses a clashing name in a different case too', async () => {
    // `matchByName` lowercases both sides, in the exact branch and the
    // substring one, so "INVERSION" and "Inversion" are the same account to
    // anything resolving by name. Letting them coexist produces exactly the
    // ambiguity the clash guard exists to prevent, so a case-sensitive
    // comparison here would be a hole rather than a stricter rule.
    await budget('acct-clash-case');

    const result = await handlerFor()({ account: 'BHD Nomina', name: 'INVERSION' });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('already called "Inversion"');
    expect((await stateOf(onBudget)).name).toBe('BHD Nomina');
  }, 60_000);

  it('refuses an ambiguous account instead of picking one', async () => {
    await createFreshBudget(async () => {
      await api.createAccount({ name: 'BHD Nomina', offbudget: false } as never, 0);
      await api.createAccount({ name: 'BHD Nomina USD', offbudget: false } as never, 0);
    }, 'acct-ambiguous');

    const result = await handlerFor()({ account: 'BHD', name: 'Otra cosa' });

    expect(result.isError).toBe(true);
    const text = result.content[0].text;
    expect(text.toLowerCase()).toContain('ambiguous');
    // And neither was renamed.
    const names = (await api.getAccounts()).map((a) => a.name).sort();
    expect(names).toEqual(['BHD Nomina', 'BHD Nomina USD']);
  }, 60_000);

  it('trims the name it is given', async () => {
    await budget('acct-trim');

    await handlerFor()({ account: 'BHD Nomina', name: '  Nomina Principal  ' });

    expect((await stateOf(onBudget)).name).toBe('Nomina Principal');
  }, 60_000);
});
