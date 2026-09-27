import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as api from '@actual-app/api';
import { ensureConnection, getConfig, getInternal } from '../../connection.js';
import { probeServer } from '../../utils/server-probe.js';
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
 * ## Two causes, one symptom, and this fixes only one of them
 *
 * A broken sync state and a closed desktop app fail the same way from here, and
 * this is the reflex for both (#89). It cannot fix the second: with the app
 * shut, its server on port 5007 is not listening and there is nothing to repair
 * against. Running anyway spends a state-changing operation on a problem that
 * is "the app is not running", and fails in a way that looks like the first
 * cause, which is what made telling them apart take as long as it did.
 *
 * The check cannot be `ensureConnection` again: it returns early once
 * connected, so after a successful start it never touches the network, and the
 * case that matters is the app being closed *after* that. It asks the network
 * instead, and only that question. See `serverIsAnswering`.
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

  // Before anything is changed. A repair rebuilds local state against the
  // server, so with nothing on the other end there is nothing to rebuild
  // against, and this is not the fix for that anyway.
  let serverURL: string | undefined;
  try {
    serverURL = getConfig().serverURL;
  } catch {
    // No usable configuration. `ensureConnection` above has already failed on
    // it, and saying "unreachable" would name the wrong problem.
    serverURL = undefined;
  }

  const probe = serverURL ? await probeServer(serverURL) : 'answering';

  if (probe === 'unusable-url') {
    // Its own sentence. This is a configuration problem, and the advice for an
    // absent server — open the app, start the server — would send the reader
    // somewhere with nothing to find. Measured: `http://127.0.0.1:99999` is
    // not a URL as far as `new URL` is concerned, because the port is out of
    // range, and the repair used to run anyway.
    throw new Error(
      `ACTUAL_SERVER_URL is not an address this can reach: ${serverURL}. ` +
        `Nothing was repaired. Check the value where you configured this server; ` +
        `a port outside 1-65535 makes the whole URL invalid, which is easy to do ` +
        `by mistyping one.`,
    );
  }

  if (probe === 'not-answering') {
    throw new Error(
      [
        `Nothing is listening at ${serverURL}, so the sync state was not touched.`,
        '',
        'A sync repair rebuilds local bookkeeping against the server, so it cannot run',
        'with the server absent, and it is not what fixes this. Two different problems',
        'fail the same way from here and this only fixes one of them:',
        '',
        `  the server is not running   which is what this is. If your budget lives in the`,
        '                              Actual desktop app, its server runs on port 5007 and',
        '                              only while the app is open, so open it and try what',
        '                              failed again before repairing anything.',
        '  the sync state is broken    which this does fix, once the server answers.',
      ].join('\n'),
    );
  }

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
    { title: 'Repair sync state', readOnlyHint: false, idempotentHint: true },
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
