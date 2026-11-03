import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as api from '@actual-app/api';
import { ensureConnection, serverVersionCheck } from '../../connection.js';
import { sectionHeader } from '../../utils/formatters.js';
import { describeError } from '../../utils/errors.js';
import { configuredBudgetIds, openBudgetId, servesManyBudgets } from '../../utils/budgets.js';
import { poolInUse } from '../../workers/current.js';
import { versionNote, type VersionCheck } from '../../utils/server-version.js';

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
        // With workers, the front end opens no budget, so there is no
        // `getBudgets` to ask here and no name to show for a budget that is
        // not open: the name lives inside the file. What it can say is which
        // ids this server serves and which of them are open right now, and
        // the id is what a caller passes anyway (#229).
        const pool = poolInUse();
        if (servesManyBudgets()) {
          // Whatever the pool is doing, including not existing yet: with
          // more than one budget this process opens none of them, and
          // asking the engine here is how the front end would end up
          // holding one (#229).
          const open = new Set(pool?.openBudgets() ?? []);
          // The name comes from the worker that opened the budget, which is
          // the only process that can read it: it is inside the file. The
          // pool keeps the last one it was told, so a budget that was open
          // this morning is still named after its worker was closed for
          // idleness.
          const known = pool?.knownBudgets() ?? new Map();
          const serving = configuredBudgetIds();
          const lines: string[] = [sectionHeader(`Budgets (${serving.length})`), ''];
          // And what its worker said about the two versions, which the
          // front end cannot work out either: it has no connection to the
          // Actual server to ask. The line goes beside the budget it was
          // said about, and the sentence that explains it goes once.
          let mismatch: VersionCheck | undefined;
          for (const id of serving) {
            const report = known.get(id);
            const name = report?.name;
            const differs = report?.version?.kind === 'mismatch';
            if (differs && mismatch === undefined) mismatch = report?.version;
            const state = open.has(id) ? '[open]' : name === undefined ? '(not opened yet)' : '(closed)';
            const versions =
              report?.version?.kind === 'mismatch'
                ? `  Actual ${report.version.server}, library ${report.version.library}`
                : '';
            lines.push(
              name === undefined
                ? `${id}  ${state}${versions}`
                : `${name} (${id})  ${state}${versions}`,
            );
          }
          lines.push('');
          lines.push(
            'Each budget is opened in its own process, as it is first asked for. A name is ' +
              'inside the budget file, so a budget nobody has opened yet is listed by id ' +
              'alone. Pass the id, whichever is shown.',
          );
          if (mismatch !== undefined) {
            lines.push('');
            lines.push(versionNote(mismatch) ?? '');
          }
          return { content: [{ type: 'text', text: lines.join('\n') }] };
        }

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

        // What the versions said when the budget was opened, where somebody
        // can act on it (#229). The same thing went to stderr then, and a
        // server a client starts in the background has nobody reading that.
        const checked = serverVersionCheck();
        const note = checked === undefined ? undefined : versionNote(checked);
        if (note !== undefined) {
          lines.push('');
          lines.push(note);
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
