import { utils } from '@actual-app/api';

export function centsToAmount(cents: number): number {
  return utils.integerToAmount(cents);
}

export function amountToCents(amount: number): number {
  return utils.amountToInteger(amount);
}

export function formatMoney(cents: number): string {
  const amount = centsToAmount(cents);
  return new Intl.NumberFormat('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(amount);
}
