import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as api from '@actual-app/api';
import { openBudgetId } from '../utils/budgets.js';
import { startedByPool } from './worker-env.js';

/**
 * What a worker tells the pool about the budget it holds (#229).
 *
 * The front end has no budget open and never will, so it cannot read the
 * name of one: the name lives inside the budget file, which is in a
 * worker's data directory. Without this, `list_budgets` on a deployment
 * with workers can only print sync ids, which is the one place a person
 * most needs a name.
 *
 * It goes up as a log notification rather than as an answer to a question,
 * so it costs no round trip: the worker already has the name by the time it
 * has opened the budget, and the pool is already listening on that pipe.
 * The pool keeps the last thing it was told, so the name survives the
 * worker being closed for idleness fifteen minutes later.
 *
 * Nothing here is load bearing. If it fails, or the server is old, or the
 * capability is not declared, the only consequence is a list of ids.
 */
export const WORKER_LOGGER = 'actual-budget-mcp/worker';

/** What the pool is willing to believe about a budget. */
export interface BudgetReport {
  budgetId: string;
  name?: string;
}

/** The longest name this will carry, so a reply cannot be filled from below. */
export const MAX_NAME = 200;

interface BudgetRow {
  id?: string;
  name?: string;
  groupId?: string | null;
  cloudFileId?: string | null;
}

/** The name of the budget this process has open, if the engine knows it. */
async function openBudgetName(budgetId: string): Promise<string | undefined> {
  const known = (await api.getBudgets()) as unknown as BudgetRow[];
  for (const budget of known) {
    for (const key of [budget.groupId, budget.cloudFileId, budget.id]) {
      if (key === budgetId && typeof budget.name === 'string' && budget.name !== '') {
        return budget.name;
      }
    }
  }
  return undefined;
}

/**
 * Say it once, after the budget is open.
 *
 * Only from a process the pool started: anywhere else there is nobody
 * listening, and the capability that carries it is not declared.
 */
export async function reportToPool(server: McpServer): Promise<void> {
  if (!startedByPool()) return;
  const budgetId = openBudgetId();
  if (budgetId === undefined) return;

  try {
    const name = await openBudgetName(budgetId);
    const report: BudgetReport = { budgetId, ...(name === undefined ? {} : { name }) };
    await server.server.sendLoggingMessage({
      level: 'info',
      logger: WORKER_LOGGER,
      data: report as unknown as Record<string, unknown>,
    });
  } catch {
    // A name is a kindness. Failing to find one is not a reason to say
    // anything to anybody.
  }
}
