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
  return (await budgetCurrencyOutcome()).code;
}

/**
 * The same read, saying whether it got an answer at all.
 *
 * Two different situations arrive as "no currency": a budget that has none
 * set, which is the ordinary case, and a read that could not be made. They
 * need opposite handling. A budget with no currency is two decimal places; a
 * failed read is no information, and treating it as "no currency" would move
 * a budget in yen back to hundredths, writing 10,000 where 100 was asked for
 * and saying nothing.
 *
 * `read` is true when either store answered, whatever it answered. One store
 * throwing while the other says nothing is still an answer about the budget,
 * because the value lives in whichever of them has it.
 */
export async function budgetCurrencyOutcome(): Promise<{ read: boolean; code?: string }> {
  let read = false;
  for (const method of ['preferences/get', 'load-prefs']) {
    try {
      const prefs = (await getInternal().send(method as never)) as
        | { defaultCurrencyCode?: unknown }
        | undefined;
      read = true;
      const code = prefs?.defaultCurrencyCode;
      if (typeof code === 'string' && code.length > 0) return { read, code };
    } catch {
      // Either store may be unavailable; the other one is still worth asking.
    }
  }
  return { read };
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

/**
 * Read the open budget's currency and keep its decimal count.
 *
 * A read that failed changes nothing. The count it already had came from a
 * read that worked, and nothing about the budget has been learned since, so
 * replacing it with the default would turn a transient failure into amounts
 * a hundred times too large in a budget in yen, written with no sign that
 * anything went wrong. A budget whose currency has genuinely been cleared
 * does come back to the default, because that read did answer.
 */
export async function refreshBudgetDecimalPlaces(): Promise<number> {
  const outcome = await budgetCurrencyOutcome();
  if (!outcome.read) return activeDecimalPlaces;
  activeDecimalPlaces = decimalPlacesFor(outcome.code);
  return activeDecimalPlaces;
}

/** Back to the default, for tests and for a connection being torn down. */
export function resetBudgetDecimalPlaces(): void {
  activeDecimalPlaces = DEFAULT_DECIMAL_PLACES;
}

/** The part of `McpServer` this needs: somewhere to register a tool. */
export interface ToolRegistrar {
  tool: (...args: never[]) => unknown;
}

/**
 * Re-read the budget currency before a tool that writes.
 *
 * The refresh in `syncNow` covers reads and keeps a long-lived server
 * current, and it is not enough on its own: a write converts its amount at
 * the top of the handler and syncs at the end, so the first write after a
 * currency changed in the app still converted with the old count. Measured
 * against the engine, with the preference moved to JPY and nothing else:
 * `create_transaction` for 100 wrote 10,000.
 *
 * So the write tools re-read it on the way in. Here rather than in the
 * twenty-odd files that write, for the same reason the read sync is wrapped
 * at registration: a tool added later should not have to remember, and
 * `readOnlyHint` is the same flag everything else uses to tell the two apart.
 *
 * It costs a local query, not a round trip: the preference comes from the
 * budget on disk. Failures are swallowed by the read itself, which keeps the
 * count it already had, so a write is never refused over a formatting detail.
 */
export function withCurrentCurrency<T extends ToolRegistrar>(server: T): T {
  const wrapped = Object.create(server) as T;
  const originalTool = server.tool.bind(server) as (...args: unknown[]) => unknown;

  (wrapped as { tool: unknown }).tool = (...args: unknown[]) => {
    const annotations = args.find(
      (a): a is { readOnlyHint?: boolean } =>
        typeof a === 'object' && a !== null && 'readOnlyHint' in a,
    );
    // Reads go through `refreshBeforeRead`, which syncs, which re-reads it.
    if (annotations?.readOnlyHint === true) return originalTool(...args);

    const handler = args[args.length - 1] as (...handlerArgs: unknown[]) => Promise<unknown>;
    const wrappedHandler = async (...handlerArgs: unknown[]) => {
      await refreshBudgetDecimalPlaces();
      return handler(...handlerArgs);
    };

    return originalTool(...args.slice(0, -1), wrappedHandler);
  };

  return wrapped;
}
