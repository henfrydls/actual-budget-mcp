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
