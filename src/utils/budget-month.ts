import * as api from '@actual-app/api';
import { describeError } from './errors.js';
import type { BudgetMonth } from '../types.js';

/**
 * Read a month's budget, or nothing if that month is outside the budget.
 *
 * `api.getBudgetMonth` throws `No budget exists for month: 2025-12` for a month
 * before the budget file starts, and a tool reading a window of months one at a
 * time dies on the first one. Measured while adding the window anchor to
 * `category_trends` (#90): asking for 24 months returned
 * `Error: No budget exists for month: 2025-12` and nothing else, no matter how
 * much data the months inside the budget held.
 *
 * That matters beyond a long window: the same issue says the defaults of 6 and
 * 3 months have been read as hard limits by people who then rebuilt history
 * from differences. Telling them the default is not a limit while asking for 24
 * fails is worse than saying nothing.
 *
 * Only that one message is swallowed. Anything else is a real failure and is
 * rethrown, because a tool that returns "no data" for a broken connection is
 * how #80 stayed invisible.
 */
export async function budgetMonthOrMissing(month: string): Promise<BudgetMonth | null> {
  try {
    return (await api.getBudgetMonth(month)) as unknown as BudgetMonth;
  } catch (error) {
    if (/No budget exists for month/i.test(describeError(error))) return null;
    throw error;
  }
}

/**
 * Split a window into the months the budget covers and the ones it does not.
 *
 * The missing ones are handed back rather than dropped, so a reply can say the
 * window was shorter than asked for instead of quietly showing fewer rows.
 */
export async function readWindow(
  months: string[],
): Promise<{ present: Array<{ month: string; budget: BudgetMonth }>; missing: string[] }> {
  const present: Array<{ month: string; budget: BudgetMonth }> = [];
  const missing: string[] = [];
  for (const month of months) {
    const budget = await budgetMonthOrMissing(month);
    if (budget) present.push({ month, budget });
    else missing.push(month);
  }
  return { present, missing };
}
