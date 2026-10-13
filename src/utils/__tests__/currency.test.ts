import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

const send = vi.fn();
vi.mock('../../connection.js', () => ({ getInternal: () => ({ send }) }));

import {
  budgetCurrencyCode,
  budgetDecimalPlaces,
  decimalPlacesFor,
  refreshBudgetDecimalPlaces,
  resetBudgetDecimalPlaces,
  DECIMAL_PLACES_BY_CODE,
  DEFAULT_DECIMAL_PLACES,
} from '../currency.js';
import { amountToCents, centsToAmount, formatMoney } from '../money.js';

/**
 * Which preference store answers, and what happens when neither does.
 *
 * Each of these was a surviving mutation before it was a test: swapping the
 * order of the two stores, dropping the fallback, and having the `catch`
 * return a currency rather than nothing. All three are invisible on a budget
 * that has no currency set, which is every budget in the Dominican Republic,
 * so none of them would have been noticed by using the thing.
 */
describe('budgetCurrencyCode', () => {
  // Braces on purpose. `mockReset()` returns the mock, an arrow without them
  // returns it, and vitest calls whatever a hook returns as its teardown — so
  // the mock got invoked after the test, and the one that throws turned into
  // an unhandled rejection reported as a failure of the test that had passed.
  beforeEach(() => {
    send.mockReset();
  });

  it('prefers the synced store, which is the one the app writes to', async () => {
    // Both answer, with different values. Reversing the order is a mutation
    // that needs this to be caught: on a real budget the metadata store is
    // empty, so reversing it looks harmless until someone has written to both.
    send.mockImplementation(async (method: string) =>
      method === 'preferences/get'
        ? { defaultCurrencyCode: 'JPY' }
        : { defaultCurrencyCode: 'USD' },
    );
    expect(await budgetCurrencyCode()).toBe('JPY');
  });

  it('still falls back to the metadata store', async () => {
    // Some tooling writes with `save-prefs`, so an answer from either beats
    // none. Dropping the second attempt passes every other test here.
    send.mockImplementation(async (method: string) =>
      method === 'preferences/get' ? {} : { defaultCurrencyCode: 'KRW' },
    );
    expect(await budgetCurrencyCode()).toBe('KRW');
  });

  it('answers nothing when neither store has it', async () => {
    send.mockResolvedValue({});
    // Not `'USD'`, and not a guess. Nothing configured has to reach the engine
    // as nothing configured, so it applies its own fallback of two decimals.
    // Returning a currency here would format a budget in someone else's.
    expect(await budgetCurrencyCode()).toBeUndefined();
  });

  it('answers nothing when both stores throw, rather than guessing', async () => {
    // Thrown from the call, not `mockRejectedValue`: that builds the rejected
    // promise when the mock is configured, so it is unhandled for a moment and
    // this repository's own process guard (#39) sees it.
    send.mockImplementation(async () => {
      throw new Error('handler is not a function');
    });
    expect(await budgetCurrencyCode()).toBeUndefined();
  });

  it('treats an empty string as not configured', async () => {
    send.mockResolvedValue({ defaultCurrencyCode: '' });
    expect(await budgetCurrencyCode()).toBeUndefined();
  });

  it('asks the synced store first, in that order', async () => {
    // The order is the behaviour, so it is checked directly as well: a value
    // only in the first store proves preference, this proves sequence.
    send.mockResolvedValue({});
    await budgetCurrencyCode();
    expect(send.mock.calls.map((c) => c[0])).toEqual(['preferences/get', 'load-prefs']);
  });
});

/**
 * The decimal counts, against the engine's own table.
 *
 * `currencies` is where Actual says how many decimal places each currency has,
 * and it is not exported, so the entries that differ from the default are
 * written out by hand in `currency.ts`. The same shape of list, written out by
 * hand from an issue, is what missed a rule field and shipped a bug, so it is
 * compared against the installed copy: a version that adds a currency with
 * three decimal places, or changes one of these three, fails here rather than
 * silently converting by a hundred.
 */
describe('the decimal places Actual gives each currency', () => {
  const bundle = (() => {
    // Through the package entry, because `exports` does not expose dist paths.
    const require = createRequire(import.meta.url);
    return readFileSync(require.resolve('@actual-app/api'), 'utf8');
  })();

  /** Every `{code, decimalPlaces}` in the engine's table. */
  function currenciesFromEngine(): { code: string; decimalPlaces: number }[] {
    const start = bundle.indexOf('var currencies = [');
    expect(start, 'the currency table is not in the bundle any more, so this guard reads nothing')
      .toBeGreaterThan(-1);

    const open = bundle.indexOf('[', start);
    let depth = 0;
    let end = open;
    for (; end < bundle.length; end += 1) {
      if (bundle[end] === '[') depth += 1;
      else if (bundle[end] === ']') {
        depth -= 1;
        if (depth === 0) {
          end += 1;
          break;
        }
      }
    }

    const block = bundle.slice(open, end);
    const found: { code: string; decimalPlaces: number }[] = [];
    // Each entry carries its code and, further down, its decimal count.
    const entry = /code:\s*"([A-Z]*)"[\s\S]*?decimalPlaces:\s*(\d+)/g;
    let match: RegExpExecArray | null;
    while ((match = entry.exec(block)) !== null) {
      found.push({ code: match[1], decimalPlaces: Number(match[2]) });
    }
    return found;
  }

  it('finds enough of the table for the comparison to mean something', () => {
    // A guard that parses nothing reports agreement with an empty list.
    const found = currenciesFromEngine();
    expect(found.length).toBeGreaterThan(40);
    expect(found.map((c) => c.code)).toContain('JPY');
  });

  it('lists exactly the currencies that are not two places', () => {
    const odd = currenciesFromEngine().filter((c) => c.decimalPlaces !== DEFAULT_DECIMAL_PLACES);
    const asEngine = Object.fromEntries(odd.map((c) => [c.code, c.decimalPlaces]));
    expect(DECIMAL_PLACES_BY_CODE).toEqual(asEngine);
  });

  it('agrees with the engine on every currency it ships', () => {
    // Not only the odd ones: a currency dropping to one decimal place would
    // pass the test above by being absent from both sides.
    for (const currency of currenciesFromEngine()) {
      expect(decimalPlacesFor(currency.code), `${currency.code}`).toBe(currency.decimalPlaces);
    }
  });

  it('falls back the way the engine does, for a code it has never heard of', () => {
    // `getCurrency` returns `currencies[0]`, which is `{code: "", decimalPlaces: 2}`.
    expect(decimalPlacesFor(undefined)).toBe(DEFAULT_DECIMAL_PLACES);
    expect(decimalPlacesFor('')).toBe(DEFAULT_DECIMAL_PLACES);
    expect(decimalPlacesFor('XYZ')).toBe(DEFAULT_DECIMAL_PLACES);
  });

  it('reads a code in any case, since it is only ever compared', () => {
    expect(decimalPlacesFor('jpy')).toBe(0);
  });
});

/**
 * The conversions, against the currency the budget is in.
 *
 * `money.ts` is synchronous and called from about thirty places, so it reads a
 * count that is refreshed when a budget opens and after each sync. These are
 * the figures from the issue, in both directions (#141).
 */
describe('amounts in a currency with no decimal places', () => {
  beforeEach(() => {
    send.mockReset();
    resetBudgetDecimalPlaces();
  });

  it('starts at two places, before anything has been read', () => {
    // Which is what every amount was converted with before this existed, so a
    // budget that never gets as far as reading a preference is unaffected.
    expect(budgetDecimalPlaces()).toBe(DEFAULT_DECIMAL_PLACES);
    expect(amountToCents(100)).toBe(10_000);
  });

  it('writes a whole yen once the budget says JPY', async () => {
    send.mockResolvedValue({ defaultCurrencyCode: 'JPY' });
    expect(await refreshBudgetDecimalPlaces()).toBe(0);

    expect(amountToCents(100)).toBe(100);
    expect(centsToAmount(1000)).toBe(1000);
    // The figure from the issue, read back the way it was stored.
    expect(formatMoney(-1000)).toBe('-1,000');
  });

  it('keeps the decimals for a currency that has them', async () => {
    send.mockResolvedValue({ defaultCurrencyCode: 'USD' });
    expect(await refreshBudgetDecimalPlaces()).toBe(DEFAULT_DECIMAL_PLACES);

    expect(amountToCents(12.34)).toBe(1234);
    expect(centsToAmount(1234)).toBe(12.34);
    expect(formatMoney(-1234)).toBe('-12.34');
  });

  it('goes back to two when a preference cannot be read at all', async () => {
    // A budget with no currency set, which is the ordinary case, and a store
    // that errors both land here.
    send.mockResolvedValue({ defaultCurrencyCode: 'KRW' });
    await refreshBudgetDecimalPlaces();
    expect(budgetDecimalPlaces()).toBe(0);

    send.mockResolvedValue({});
    expect(await refreshBudgetDecimalPlaces()).toBe(DEFAULT_DECIMAL_PLACES);
    expect(formatMoney(-1234)).toBe('-12.34');
  });
});
