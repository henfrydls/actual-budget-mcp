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
