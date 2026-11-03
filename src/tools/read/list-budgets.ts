import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as api from '@actual-app/api';
import { ensureConnection } from '../../connection.js';
import { sectionHeader } from '../../utils/formatters.js';
import { describeError } from '../../utils/errors.js';
import { configuredBudgetIds, openBudgetId } from '../../utils/budgets.js';

/**
 * The budgets this server serves, by the id a caller has to pass (#229).
 *
 * Until now the only way to know which budget a reply came from was to know
 * what the server was configured with, and the id a caller needs is not the
 * one the engine uses locally: `ACTUAL_BUDGET_ID` holds the sync id, which
 * is `groupId` on what the engine returns, and the local folder has an id of
 * its own that means nothing to anyone else.
 *
 * It lists what the operator configured and nothing else. The Actual server
 * would answer for every budget on the account, and asking for one of those
 * by id is not a way to open it: which budgets a deployment serves is the
 * operator's decision.
 */
interface BudgetRow {
  id?: string;
  name?: string;
  groupId?: string | null;
  cloudFileId?: string | null;
}

export function registerListBudgets(server: McpServer): void {
  server.tool(
    'list_budgets',
    'List the budgets this server is configured to serve, with the sync id each one is ' +
      'asked for by, and which one is open.',
    {},
    { title: 'List budgets', readOnlyHint: true },
    async () => {
      try {
        await ensureConnection();
        const known = (await api.getBudgets()) as unknown as BudgetRow[];
        const open = openBudgetId();
        const configured = configuredBudgetIds();

        const byId = new Map<string, BudgetRow>();
        for (const budget of known) {
          for (const key of [budget.groupId, budget.cloudFileId, budget.id]) {
            if (typeof key === 'string' && key !== '' && !byId.has(key)) byId.set(key, budget);
          }
        }

        const lines: string[] = [sectionHeader(`Budgets (${configured.length})`), ''];
        for (const id of configured) {
          const found = byId.get(id);
          // A budget this server has never opened has no local copy and no
          // name to show: the name lives in the file, and the file is not
          // here yet. Saying the id alone is better than inventing one.
          const name = found?.name ?? '(not downloaded here)';
          lines.push(`${name} (${id})${id === open ? '  [open]' : ''}`);
        }

        if (configured.length === 1) {
          lines.push('');
          lines.push(
            'This server serves one budget. Set ACTUAL_BUDGET_IDS to serve more than one.',
          );
        }

        return { content: [{ type: 'text', text: lines.join('\n') }] };
      } catch (error) {
        return {
          content: [{ type: 'text', text: `Error: ${describeError(error)}` }],
          isError: true,
        };
      }
    },
  );
}
