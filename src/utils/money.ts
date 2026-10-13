import { utils } from '@actual-app/api';
import { budgetDecimalPlaces } from './currency.js';

/**
 * Amounts in and out, in the budget's own currency.
 *
 * Actual stores an amount as an integer in the currency's smallest unit, and
 * the conversion depends on how many decimal places that currency has. These
 * three functions used to let both SDK helpers default to two, which is right
 * for most currencies and wrong by a factor of a hundred for the three that
 * have none (#141). `budgetDecimalPlaces()` is the count for the budget that
 * is open, and it is two until something says otherwise.
 */
export function centsToAmount(cents: number): number {
  return utils.integerToAmount(cents, budgetDecimalPlaces());
}

export function amountToCents(amount: number): number {
  return utils.amountToInteger(amount, budgetDecimalPlaces());
}

export function formatMoney(cents: number): string {
  const places = budgetDecimalPlaces();
  const amount = utils.integerToAmount(cents, places);
  // The decimals shown follow the currency: printing a yen as "1,000.00"
  // claims a precision the amount does not have, and reads as a different
  // figure to anyone used to the currency.
  return new Intl.NumberFormat('en-US', {
    minimumFractionDigits: places,
    maximumFractionDigits: places,
  }).format(amount);
}

/**
 * Whether an amount is a round hundred in the budget's own currency.
 *
 * A difference like 100.00 or 300.00 is common by chance, so an amount match
 * against one is weak evidence; one with centavos is worth chasing. The
 * threshold was a hundred written in cents, which in a currency with no
 * decimal places called every multiple of 10,000 yen round and nothing else
 * (#141).
 */
export function isRoundHundred(cents: number): boolean {
  return Math.abs(cents) % amountToCents(100) === 0;
}
