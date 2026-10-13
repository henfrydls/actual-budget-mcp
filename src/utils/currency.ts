import { getInternal } from '../connection.js';

/**
 * The currency the budget is configured in, or nothing if it has none.
 *
 * The app keeps it as a **synced** preference, which `preferences/get` returns
 * and `load-prefs` does not. An earlier version of this read `load-prefs`, on a
 * measurement taken after saving the value with `save-prefs` — the metadata
 * store, not the one the app writes to. Saved the way the app saves it:
 *
 *   preferences/get                 {"defaultCurrencyCode":"JPY"}
 *   load-prefs.defaultCurrencyCode  undefined
 *
 * So on a real budget the earlier version found nothing and changed nothing.
 * Both are read now, the synced one first, because `save-prefs` is still what
 * some tooling writes and an answer from either is better than none.
 *
 * It matters because `getCurrency` falls back to `currencies[0]`, which is
 * `{code: "", name: "None", decimalPlaces: 2}`, and that decimal count is the
 * divisor an amount is formatted with. On a currency with no decimal places
 * the result is wrong by a factor of a hundred (#115).
 *
 * The empty string is treated as absent, and that is housekeeping rather than
 * a guard: `getCurrency("")` lands on the same fallback as `getCurrency(undefined)`,
 * so returning one or the other changes nothing the engine does. It is written
 * this way so `undefined` means "not configured" to everything upstream, and
 * noted because mutating it away changes no test and never will.
 *
 * Nothing here throws. A tool that cannot read a preference should still do
 * the work it was asked to do, with the engine's own fallback, rather than
 * refuse over a formatting detail.
 */
export async function budgetCurrencyCode(): Promise<string | undefined> {
  for (const method of ['preferences/get', 'load-prefs']) {
    try {
      const prefs = (await getInternal().send(method as never)) as
        | { defaultCurrencyCode?: unknown }
        | undefined;
      const code = prefs?.defaultCurrencyCode;
      if (typeof code === 'string' && code.length > 0) return code;
    } catch {
      // Either store may be unavailable; the other one is still worth asking.
    }
  }
  return undefined;
}

/**
 * How many decimal places an amount has, by currency.
 *
 * Actual keeps every amount as an integer in the currency's smallest unit, and
 * converts with the currency's own decimal count. Three of the fifty one
 * currencies it ships have none: a yen is a whole yen, not a hundredth of one.
 *
 * `amountToInteger` and `integerToAmount` both default to two when nobody
 * passes a count, and this server was calling them with no argument, so in a
 * budget in one of those three every amount was wrong by a factor of a hundred
 * in both directions: asking to spend 100 wrote 10,000, and a real 1,000 was
 * reported as 10.00 (#141).
 *
 * Only the currencies that differ from the default are listed. The engine's
 * table is not exported, so this is written out by hand and a test compares it
 * against the installed copy: a later version that adds a currency with three
 * decimal places, or changes one of these, fails that test rather than passing
 * quietly, which is how the same mistake was caught in the rule fields.
 */
export const DEFAULT_DECIMAL_PLACES = 2;

export const DECIMAL_PLACES_BY_CODE: Readonly<Record<string, number>> = {
  IRR: 0,
  JPY: 0,
  KRW: 0,
};

/**
 * The decimal count for a currency code.
 *
 * An unknown code, an empty one and a missing one all give the default, which
 * is what the engine's own `getCurrency` does: it falls back to `currencies[0]`,
 * `{code: "", name: "None", decimalPlaces: 2}`. A budget with no currency set
 * is the ordinary case for anyone who never opened that setting, so it cannot
 * be an error.
 */
export function decimalPlacesFor(code: string | undefined): number {
  if (!code) return DEFAULT_DECIMAL_PLACES;
  const places = DECIMAL_PLACES_BY_CODE[code.toUpperCase()];
  return places ?? DEFAULT_DECIMAL_PLACES;
}

/**
 * The decimal count of the budget that is open, for the conversions in
 * `money.ts`.
 *
 * Those conversions are synchronous and called from about thirty places, while
 * reading the preference is a round trip to the engine, so the value is read
 * once when a budget is opened and again after each sync that actually
 * happened, and held here in between. A sync is where a currency changed in
 * the app would arrive, so a long-lived server picks the change up within the
 * same minute it picks up a recategorised transaction.
 *
 * It starts at the default, which is what every amount was converted with
 * before this existed. A budget whose preference cannot be read, or that has
 * no currency set, therefore behaves exactly as it did.
 */
let activeDecimalPlaces = DEFAULT_DECIMAL_PLACES;

export function budgetDecimalPlaces(): number {
  return activeDecimalPlaces;
}

/** Read the open budget's currency and keep its decimal count. */
export async function refreshBudgetDecimalPlaces(): Promise<number> {
  activeDecimalPlaces = decimalPlacesFor(await budgetCurrencyCode());
  return activeDecimalPlaces;
}

/** Back to the default, for tests and for a connection being torn down. */
export function resetBudgetDecimalPlaces(): void {
  activeDecimalPlaces = DEFAULT_DECIMAL_PLACES;
}
