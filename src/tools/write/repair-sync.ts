import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as api from '@actual-app/api';
import { ensureConnection, getInternal } from '../../connection.js';
import { describeError } from '../../utils/errors.js';

/**
 * Rebuild the local sync state, then sync.
 *
 * #41: when a budget goes out-of-sync there was no way out from inside the MCP
 * server — every tool failed, and the usual remedies do not work: wiping
 * ACTUAL_DATA_DIR reproduces the same error on the next download (the
 * inconsistency is in the sync state, not the cache), and restarting the app or
 * the server changes nothing. Actual's own repair is reachable through the
 * internal `sync-repair` handler, which is what the UI's "Repair sync" runs.
 *
 * Non-destructive: it rebuilds sync bookkeeping, not budget data.
 *
 * Returns the human-readable confirmation lines.
 */
export async function repairSyncState(): Promise<string[]> {
  // Deliberately tolerate a failed connection: ensureConnection() runs
  // downloadBudget(), and an out-of-sync budget is precisely what makes that
  // throw — bailing out here would make this tool useless in the only
  // situation it exists for. By then `api.init()` has already returned (so
  // `send` is available) and the budget itself is loaded; only the sync step
  // failed. getInternal() throws its own clear error if init never ran.
  await ensureConnection().catch(() => undefined);

  try {
    await getInternal().send('sync-repair');
  } catch (error) {
    throw new Error(`Sync repair failed: ${describeError(error)}`);
  }

  await api.sync();

  return [
    'Sync repair completed.',
    '  The local sync state was rebuilt and synced with the server.',
    '  No budget data was modified (only sync bookkeeping).',
  ];
}

export function registerRepairSync(server: McpServer): void {
  server.tool(
    'repair_sync',
    "Repair the budget's sync state when operations fail with an out-of-sync error. " +
      'Rebuilds sync bookkeeping without modifying budget data. Use this when other ' +
      'tools report that the budget is out of sync.',
    {},
    { readOnlyHint: false, idempotentHint: true },
    async () => {
      try {
        const lines = await repairSyncState();
        return { content: [{ type: 'text', text: lines.join('\n') }] };
      } catch (error) {
        const message = describeError(error);
        return {
          content: [{ type: 'text', text: `Error: ${message}` }],
          isError: true,
        };
      }
    },
  );
}
