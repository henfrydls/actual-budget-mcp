import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

vi.mock('@actual-app/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@actual-app/api')>();
  return { ...actual, sync: vi.fn().mockResolvedValue(undefined) };
});

vi.mock('../../../connection.js', () => ({
  ensureConnection: vi.fn().mockResolvedValue(undefined),
}));

import { initTestEngine, shutdownTestEngine, createFreshBudget, api } from './actual-engine.js';
import { registerSpendingByCategory } from '../../analysis/spending-by-category.js';
import { registerGetBudgetSummary } from '../../read/get-budget-summary.js';

const skip = process.env.SKIP_ACTUAL_INTEGRATION === '1';

type Handler = (args: Record<string, unknown>) => Promise<{
  content: Array<{ type: string; text: string }>;
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

/** Every percentage in the text, as numbers. */
const sharesIn = (text: string) =>
  [...text.matchAll(/(\d+(?:\.\d+)?)%/g)].map((m) => Number(m[1]));

/**
 * #128: shares that added up to more than 100%.
 *
 * The total was the algebraic sum of the rows while each row's share was its
 * absolute value over that total, so a category whose net was positive shrank
 * the denominator and inflated everything else.
 */
describe.skipIf(skip)('spending shares with money coming in', () => {
  beforeAll(async () => {
    await initTestEngine();
  }, 60_000);

  afterAll(async () => {
    await shutdownTestEngine();
  });

  async function budget(name: string, rows: Array<[string, number]>) {
    await createFreshBudget(async () => {
      const acct = await api.createAccount({ name: 'Checking', type: 'checking' } as never, 0);
      const g = await api.createCategoryGroup({ name: 'Gastos' } as never);
      const txns = [];
      for (const [catName, amount] of rows) {
        const id = await api.createCategory({ name: catName, group_id: g } as never);
        txns.push({ date: '2026-09-05', amount, category: id });
      }
      await api.addTransactions(acct, txns as never);
    }, name);
  }

  it('gives no share to a row that brought money in, and the rest add to 100%', async () => {
    // The exact figures from the issue: they used to read 83.3%, 41.7% and
    // 25.0%, adding to 150%.
    await budget('shares-positive', [
      ['Rent', -10000],
      ['Groceries', -5000],
      ['Refunds', 3000],
    ]);

    const result = await handlerFor(registerSpendingByCategory)({
      start_date: '2026-09-01',
      end_date: '2026-09-30',
    });
    const text = result.content[0].text;

    const shares = sharesIn(text);
    expect(shares).toHaveLength(2);
    expect(shares.reduce((a, b) => a + b, 0)).toBeCloseTo(100, 1);

    // The row is still shown, and says what it is instead of a share.
    expect(text).toContain('Refunds');
    expect(text).toContain('money in, not spending');

    // And the shares are checkable against the figure printed beside them:
    // 100.00 of 150.00 is 66.7%.
    expect(text).toMatch(/Rent\s+Gastos\s+-100\.00\s+66\.7%/);
    expect(text).toMatch(/Groceries\s+Gastos\s+-50\.00\s+33\.3%/);
    expect(text).toContain('Spending: -150.00');
    expect(text).toContain('Money in: 30.00');
    expect(text).toContain('Net:      -120.00');
  }, 60_000);

  it('leaves the figures alone when nothing brought money in', async () => {
    // The claim that this only changes the broken case, pinned rather than
    // asserted in prose. The column heading is more precise than it was, but
    // every figure is what it was before.
    await budget('shares-ordinary', [
      ['Rent', -10000],
      ['Groceries', -5000],
    ]);

    const result = await handlerFor(registerSpendingByCategory)({
      start_date: '2026-09-01',
      end_date: '2026-09-30',
    });
    const text = result.content[0].text;

    expect(sharesIn(text)).toEqual([66.7, 33.3]);
    expect(text).toContain('Total: -150.00');
    // No three-line footer when there is nothing to separate.
    expect(text).not.toContain('Money in');
    expect(text).not.toContain('money in, not spending');
  }, 60_000);

  it('prints no percentage for a group with nothing budgeted against it', async () => {
    // Measured before the fix: -140.00 budgeted against 190.00 "spent" printed
    // as 135.7%, which reads as a real figure and is not one.
    let cat = '';
    await createFreshBudget(async () => {
      const acct = await api.createAccount({ name: 'Checking', type: 'checking' } as never, 0);
      const g = await api.createCategoryGroup({ name: 'Reembolsos Raros' } as never);
      cat = await api.createCategory({ name: 'Cosa', group_id: g } as never);
      await api.addTransactions(acct, [
        { date: '2026-09-07', amount: 19000, category: cat },
      ] as never);
    }, 'shares-negative-budget');
    await api.setBudgetAmount('2026-09', cat, -14000);

    const result = await handlerFor(registerGetBudgetSummary)({ month: '2026-09' });
    const text = result.content[0].text;

    // Anchored on the indented row, and on a name that is not a substring of
    // the section header: "Group B" also matches "Group Breakdown:", which is
    // how a first version of this test passed against the wrong line.
    const groupLine = text.split('\n').find((l) => l.startsWith('  Reembolsos Raros')) ?? '';
    expect(groupLine).not.toBe('');
    expect(groupLine).not.toMatch(/\d+(\.\d+)?%/);
    expect(groupLine).toContain('nothing budgeted to measure against');
    expect(groupLine).toContain('money came in rather than went out');
  }, 60_000);

  it('still prints a percentage for an ordinary group', async () => {
    // The guard must not swallow the normal case: a real budget with real
    // spending still gets its share.
    let cat = '';
    await createFreshBudget(async () => {
      const acct = await api.createAccount({ name: 'Checking', type: 'checking' } as never, 0);
      const g = await api.createCategoryGroup({ name: 'Gastos Normales' } as never);
      cat = await api.createCategory({ name: 'Comida', group_id: g } as never);
      await api.addTransactions(acct, [
        { date: '2026-09-07', amount: -7000, category: cat },
      ] as never);
    }, 'shares-ordinary-budget');
    await api.setBudgetAmount('2026-09', cat, 10000);

    const result = await handlerFor(registerGetBudgetSummary)({ month: '2026-09' });
    const groupLine =
      result.content[0].text.split('\n').find((l) => l.startsWith('  Gastos Normales')) ?? '';
    expect(groupLine).not.toBe('');

    expect(groupLine).toMatch(/\(70\.0%\)/);
  }, 60_000);
});
