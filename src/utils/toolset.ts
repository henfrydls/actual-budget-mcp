import { readEnv } from './env.js';
import type { McpServerLike } from './read-sync.js';

/**
 * Which tools a client is offered (#222).
 *
 * `tools/list` carries every tool on every connection: measured against a
 * real client, 41 tools and 37.0 KB, spent before the first question is
 * asked. Two things come out of that. The context is gone whatever the
 * conversation turns out to be about, and a model choosing between 41
 * descriptions picks the wrong one more often than one choosing between 17.
 *
 * So there is a smaller set, and `full` stays the default: nothing changes
 * for anyone who sets nothing.
 *
 * It is the same mechanism as `ACTUAL_READ_ONLY`, and for the same reason:
 * a tool that is never registered cannot be called, talked into being
 * called, or spent context on. The two narrow together rather than fighting,
 * because read-only decides which tools are registered at all and this
 * decides which of those are offered.
 */
export type Toolset = 'chat' | 'full';

/**
 * The everyday set: reading, recording, categorising, and moving budgeted
 * money. 17 tools, 16.7 KB, measured the same way as the 37.0 KB above.
 *
 * What is out of it is set-up and repair: creating and deleting accounts,
 * categories, groups, payees and rules, `reconcile_currency_residual` and
 * `repair_sync`. Three of those have the largest descriptions in the whole
 * list, and none of them is something a conversation about the month's
 * spending reaches for. They are still there with `full`.
 */
export const CHAT_TOOLS: ReadonlySet<string> = new Set([
  // Reading
  'list_accounts',
  'get_budget_month',
  'get_transactions',
  'get_categories',
  'get_category_balance',
  'get_budget_summary',
  'get_payees',
  // Recording and categorising
  'create_transaction',
  'create_transactions',
  'create_split_transaction',
  'create_transfer',
  'update_transaction',
  'delete_transaction',
  'recategorize_transaction',
  'run_bank_sync',
  // Moving budgeted money
  'update_budget_amount',
  'transfer_between_categories',
]);

/**
 * The configured set, or `full`.
 *
 * An unrecognised value does not refuse to start. A server that will not
 * come up because of a typo in one variable is worse than one that comes up
 * with everything and says what it did, which is the same call
 * `ACTUAL_READ_ONLY` makes.
 */
export function chosenToolset(): Toolset {
  const raw = readEnv('ACTUAL_TOOLSET');
  if (raw === undefined) return 'full';
  const value = raw.trim().toLowerCase();
  if (value === 'chat') return 'chat';
  if (value === 'full') return 'full';
  // stdout carries JSON-RPC, so this goes to stderr like every other notice.
  console.error(
    `[actual-budget-mcp] ACTUAL_TOOLSET is "${raw}", which is not "chat" or "full". ` +
      'Offering every tool.',
  );
  return 'full';
}

/**
 * Register only the tools the chosen set offers.
 *
 * By name, at the point where registration happens, rather than by editing
 * the list of `register*` calls: a tool is named once, in its own file, and
 * the set is a list of names next to the reason for it. Resources are not
 * touched, because they are not in `tools/list` and are not what this is
 * about.
 */
export function withToolset<T extends McpServerLike>(server: T, set: Toolset = chosenToolset()): T {
  if (set === 'full') return server;

  const wrapped = Object.create(server) as T;
  const originalTool = server.tool.bind(server) as (...args: unknown[]) => unknown;
  (wrapped as { tool: unknown }).tool = (...args: unknown[]) => {
    const name = args[0];
    if (typeof name === 'string' && !CHAT_TOOLS.has(name)) return undefined;
    return originalTool(...args);
  };
  return wrapped;
}
