export interface ConnectionConfig {
  serverURL: string;
  password: string;
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
