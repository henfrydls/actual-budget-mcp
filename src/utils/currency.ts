import { getInternal } from '../connection.js';

/**
 * The currency the budget is configured in, or nothing if it has none.
 *
 * Actual keeps it in the budget's own preferences as `defaultCurrencyCode`.
 * Reading it needs `load-prefs`: measured, `preferences/get` answers `{}`
 * whatever it is asked, with or without arguments, and a budget that has never
 * been given a currency simply has no such key.
 *
 * It matters because `getCurrency` falls back to `currencies[0]`, which is
 * `{code: "", name: "None", decimalPlaces: 2}`, and that decimal count is the
 * divisor an amount is formatted with. On a currency with no decimal places
 * the result is wrong by a factor of a hundred (#115).
 *
 * Nothing here throws. A tool that cannot read a preference should still do
 * the work it was asked to do, with the engine's own fallback, rather than
 * refuse over a formatting detail.
 */
export async function budgetCurrencyCode(): Promise<string | undefined> {
  try {
    const prefs = (await getInternal().send('load-prefs')) as
      | { defaultCurrencyCode?: unknown }
      | undefined;
    const code = prefs?.defaultCurrencyCode;
    return typeof code === 'string' && code.length > 0 ? code : undefined;
  } catch {
    return undefined;
  }
}
