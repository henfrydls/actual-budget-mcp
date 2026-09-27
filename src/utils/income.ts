/**
 * Whether a category is income, asked of the category and not only its group.
 *
 * Actual records this per category. A category keeps its own flag when it is
 * moved between groups, because `category-move` writes only `cat_group` and
 * `sort_order`, so dragging one across in the desktop app produces a category
 * whose flag disagrees with its group's. The engine reads the category row, in
 * `validateExpenseCategory`.
 *
 * Eight tools read the group instead, and the consequence was visible (#116):
 * a salary inside a spending group was listed as spending, `include_income:
 * false` did not exclude it, and the share column reported 104.2% of a total
 * it was inflating.
 *
 * ## Both crossed shapes, measured
 *
 * An income category inside a spending group comes back as
 * `group.is_income = false`, `category.is_income = true`, with `budgeted` and
 * `balance` both null. It is listed, and it has to be excluded.
 *
 * The opposite, an expense category inside an income group, comes back as
 * `group.is_income = true`, `category.is_income = false`, and the engine gives
 * it no budget figures at all: `budgeted`, `balance` and `spent` are all
 * `undefined`, and `setBudgetAmount` on it returns without error and changes
 * nothing, leaving the month's total at zero. So the engine does not treat it
 * as a spending category either.
 *
 * That is why the group's flag stays in the test rather than being replaced by
 * the category's. Skipping an income group whole keeps the existing behaviour
 * for a shape that has no figures to show, and this only adds the case that
 * does. Whether such a category should be reachable at all is a separate
 * question, and not one this change answers.
 */
export function isIncome(
  group: { is_income?: boolean } | undefined,
  category: { is_income?: boolean } | undefined,
): boolean {
  return group?.is_income === true || category?.is_income === true;
}

/**
 * The month's income and spending, with misfiled income categories put back.
 *
 * `getBudgetMonth` reports `totalIncome` and `totalSpent` from the engine, and
 * the engine files an income category by its group. Measured on a budget
 * holding a salary of 5,000.00 in a category flagged income inside a spending
 * group, plus a real expense of 200.00:
 *
 *   totalIncome   0          the salary is not counted as income
 *   totalSpent    4,800.00   the salary is counted as spending, against it
 *
 * Both figures are wrong by the same amount and in opposite directions, so
 * moving it across fixes both: income 5,000.00, spending -200.00, which is what
 * the account did.
 *
 * Filtering the per-group loops does not reach these two, because they do not
 * come from the loops. Without this, `get_budget_summary` still says income is
 * zero with a salary in the budget and still presents the total as money left
 * over.
 *
 * When nothing is misfiled the correction is zero and both figures are the
 * engine's own, unchanged.
 */
export function totalsWithMisfiledIncome(budget: {
  totalIncome: number;
  totalSpent: number;
  categoryGroups: Array<{ is_income?: boolean; categories?: Array<{ is_income?: boolean; spent?: number }> }>;
}): { income: number; spent: number; correction: number } {
  let correction = 0;
  for (const group of budget.categoryGroups) {
    if (group.is_income === true) continue;
    for (const category of group.categories ?? []) {
      if (category.is_income === true && typeof category.spent === 'number') {
        correction += category.spent;
      }
    }
  }
  return {
    income: budget.totalIncome + correction,
    spent: budget.totalSpent - correction,
    correction,
  };
}
