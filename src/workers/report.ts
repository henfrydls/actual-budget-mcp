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

/**
 * A budget name fit to print in a reply, or nothing.
 *
 * It arrives from another process and lands in a list where each line is a
 * budget, so a name with a newline in it is two budgets, and one ending in
 * `  [open]` is a lie about which of them is open. Measured with a name
 * carrying `\n`, a false id line, two spaces and `  [open]`, and an ANSI
 * sequence: all of it came through and the list read as something else.
 *
 * Control characters go, escape sequences with them, and the spaces that
 * are left collapse to one. What survives is a name on one line.
 */
export function tidyName(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const cleaned = raw
    // eslint-disable-next-line no-control-regex
    .replace(/\u001B\[[0-9;]*[A-Za-z]/g, ' ')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001F\u007F-\u009F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (cleaned === '' || cleaned.length > MAX_NAME) return undefined;
  return cleaned;
}

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
