export interface ConnectionConfig {
  serverURL: string;
  password: string;
  /** Session token, for servers behind OIDC where there is no password (#8721). */
  sessionToken?: string;
  budgetId: string;
  encryptionPassword?: string;
  dataDir?: string;
}

export interface BudgetMonthCategory {
  id: string;
  name: string;
  budgeted: number;
  spent: number;
  balance: number;
  carryover: boolean;
  group_id: string;
  /**
   * Whether this category is income, which Actual records per category and not
   * per group. A category keeps this flag when it is moved into a spending
   * group, since `category-move` writes only `cat_group` and `sort_order`, so a
   * group's own flag does not answer the question. The engine agrees: its
   * `validateExpenseCategory` reads `is_income` from the category row.
   *
   * The engine returns it. This interface did not declare it, which made the
   * field invisible to anything reading a budget month through these types.
   */
  is_income?: boolean;
}

export interface BudgetMonthGroup {
  id: string;
  name: string;
  is_income: boolean;
  categories: BudgetMonthCategory[];
}

export interface BudgetMonth {
  month: string;
  incomeAvailable: number;
  lastMonthOverspent: number;
  forNextMonth: number;
  totalBudgeted: number;
  toBudget: number;
  fromLastMonth: number;
  totalIncome: number;
  totalSpent: number;
  totalBalance: number;
  categoryGroups: BudgetMonthGroup[];
}
