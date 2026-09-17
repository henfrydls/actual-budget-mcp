import * as api from '@actual-app/api';
import type { ConnectionConfig } from './types.js';
import {
  claimDataDir,
  releaseDataDirLock,
  effectiveDataDir,
  ensureDataDirExists,
} from './utils/data-dir-lock.js';
import { packageVersion, actualApiVersion } from './utils/version.js';
import { readEnv } from './utils/env.js';

let initialized = false;
let initializing: Promise<void> | null = null;
/** The directory this process actually claimed, which may not be the configured one. */
let claimedDataDir: string | null = null;

/**
 * The context `api.init()` returns. Its `send` reaches Actual's internal
 * handlers, which is the only way to run maintenance operations the public API
 * does not wrap — notably `sync-repair` (#41).
 */
type ActualInternal = Awaited<ReturnType<typeof api.init>>;
let internal: ActualInternal | null = null;

export function getInternal(): ActualInternal {
  if (!internal) {
    throw new Error(
      'Not connected to Actual Budget yet. This operation needs an active connection.',
    );
  }
  return internal;
}

export function getConfig(): ConnectionConfig {
  // readEnv, not process.env: a client that leaves an optional field empty may
  // still set the variable to an unsubstituted placeholder, which is truthy.
  const serverURL = readEnv('ACTUAL_SERVER_URL');
  const password = readEnv('ACTUAL_PASSWORD');
  const sessionToken = readEnv('ACTUAL_SESSION_TOKEN');
  const budgetId = readEnv('ACTUAL_BUDGET_ID');

  if (!serverURL || !budgetId) {
    const missing = [];
    if (!serverURL) missing.push('ACTUAL_SERVER_URL');
    if (!budgetId) missing.push('ACTUAL_BUDGET_ID');
    throw new Error(
      `Missing required environment variables: ${missing.join(', ')}`,
    );
  }

  return {
    serverURL,
    password: password || '',
    sessionToken,
    budgetId,
    encryptionPassword: readEnv('ACTUAL_ENCRYPTION_PASSWORD'),
    dataDir: readEnv('ACTUAL_DATA_DIR'),
  };
}

/**
 * The tag `@actual-app/api` puts on a thrown error.
 *
 * It uses two shapes: `withErrorCode` writes `code`, while `FileDownloadError`
 * writes `reason`. Reading only `reason` meant the SDK's own wording reached
 * the user, and that wording is actively misleading — an unreachable server
 * throws `Authentication failed: server offline or unreachable`, tagged
 * `network-failure`. A closed SSH tunnel therefore read as a rejected password,
 * which is the one thing 0.8.3 set out to stop reporting.
 */
function errorCode(error: unknown): string {
  const tagged = error as { code?: unknown; reason?: unknown } | null | undefined;
  return String(tagged?.code ?? tagged?.reason ?? '');
}

/** True when nothing answered on the address, whichever shape said so. */
function isNetworkFailure(error: unknown, message: string): boolean {
  return (
    errorCode(error) === 'network-failure' ||
    message.includes('network-failure') ||
    message.includes('ECONNREFUSED') ||
    message.includes('fetch failed') ||
    // The SDK's own phrasing, kept as a backstop in case the tag is ever lost.
    message.includes('server offline or unreachable')
  );
}

/**
 * One message for "nothing answered", used by both connection steps so the
 * advice cannot drift between them.
 *
 * The port is worth naming: the desktop app's embedded server runs on 5007 and
 * only while the app is open, while a self-hosted sync server is usually 5006.
 * Pointing at the wrong one of the two is the most common way to land here, and
 * the raw failure says nothing about it.
 */
function unreachableMessage(serverURL: string): string {
  const portHint = serverURL.includes(':5006')
    ? ' If you use the Actual desktop app rather than a self-hosted server, try port 5007 instead: the app runs its own server there, and only while the app is open.'
    : serverURL.includes(':5007')
      ? " Port 5007 is the desktop app's own server, which only runs while the app is open. Open Actual and try again, or use 5006 if you meant a self-hosted server."
      : '';

  return (
    `Could not reach the Actual Budget server at ${serverURL}. ` +
    'Nothing answered on that address, so this is not a password or budget problem. ' +
    'Check that the server is running and that ACTUAL_SERVER_URL points at it.' +
    portHint
  );
}

/**
 * Run the budget download while watching for the one failure Actual reports
 * only in passing.
 *
 * A budget that a newer Actual has migrated cannot be opened by an older
 * `@actual-app/api`. Actual logs `out-of-sync-migrations` to the console and
 * then throws `No budget file is open`, which names a symptom the user cannot
 * act on: nothing about their URL, password or Sync ID is wrong, and no amount
 * of checking those will help.
 *
 * It cost an afternoon to find. The Desktop Extension bundles its dependencies,
 * so unlike an npx install it cannot pick up a newer Actual library on its own,
 * which makes this a failure people will actually meet: their Actual updates
 * itself, and the extension stops opening their budget with an error about a
 * file.
 *
 * Reading it off the console is not elegant, and the alternative is worse: the
 * marker is not on the error, so without this the message stays useless.
 */
async function downloadBudgetWatchingMigrations(
  budgetId: string,
  encryptionPassword: string | undefined,
): Promise<{ migrationsOutOfSync: boolean }> {
  let migrationsOutOfSync = false;
  const seen = (args: unknown[]) => {
    if (args.some((a) => String(a).includes('out-of-sync-migrations'))) {
      migrationsOutOfSync = true;
    }
  };

  const originals = { log: console.log, error: console.error, warn: console.warn };
  console.log = (...args: unknown[]) => { seen(args); originals.log(...args); };
  console.error = (...args: unknown[]) => { seen(args); originals.error(...args); };
  console.warn = (...args: unknown[]) => { seen(args); originals.warn(...args); };

  try {
    await api.downloadBudget(budgetId, { password: encryptionPassword });
    return { migrationsOutOfSync };
  } catch (error) {
    (error as { migrationsOutOfSync?: boolean }).migrationsOutOfSync = migrationsOutOfSync;
    throw error;
  } finally {
    console.log = originals.log;
    console.error = originals.error;
    console.warn = originals.warn;
  }
}

export async function ensureConnection(): Promise<void> {
  if (initialized) return;

  if (initializing) {
    await initializing;
    return;
  }

  initializing = (async () => {
    const config = getConfig();
    // Claiming creates the directory as a side effect, which matters: api.init()
    // tolerates a missing one but downloadBudget() then dies with a bare ENOENT
    // that masks every other diagnostic.
    //
    // #71: when the configured directory is already held by a live server this
    // steps aside to a sibling rather than sharing. Sharing is what drives a
    // budget out-of-sync, and warning about it was not enough — four live
    // servers were measured on one machine, all on one directory, every warning
    // printed correctly and never read.
    const claim = claimDataDir(packageVersion);
    const dataDir = claim.dataDir;
    claimedDataDir = dataDir;

    if (claim.shared && claim.heldBy) {
      // stderr: stdout carries JSON-RPC.
      console.error(
        `[actual-budget-mcp] warning: ${claim.contended} and every alternative are in ` +
          `use (pid ${claim.heldBy.pid} holds the first). Sharing one puts the budget out ` +
          'of sync: give each client its own ACTUAL_DATA_DIR.',
      );
    } else if (claim.contended) {
      console.error(
        `[actual-budget-mcp] ${claim.contended} is in use` +
          (claim.heldBy ? ` by pid ${claim.heldBy.pid}` : '') +
          `, so this server is using ${dataDir} instead. Two servers on one cache drive ` +
          'the budget out of sync. The first run here downloads the budget again; set ' +
          'ACTUAL_DATA_DIR per client to choose the location yourself.',
      );
    }

    try {
      // A server behind OIDC has no password to give: it issues a session token
      // instead, and passing an empty password alongside would make the SDK try
      // a password sign-in that cannot succeed. Exactly one credential goes in.
      internal = await api.init({
        dataDir,
        serverURL: config.serverURL,
        ...(config.sessionToken
          ? { sessionToken: config.sessionToken }
          : { password: config.password }),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const code = errorCode(error);

      // An expired token is not a wrong password: the fix is to issue a new
      // token, and saying "check your password" sends the user somewhere that
      // has no password to check.
      if (code === 'token-expired' || message.includes('expired session token')) {
        throw new Error(
          'The Actual server rejected the session token in ACTUAL_SESSION_TOKEN. ' +
            'It may have expired, or it may never have been valid. Generate a new one ' +
            'and update it where you configured this server. If you did not mean to use ' +
            'a token at all, clear ACTUAL_SESSION_TOKEN: when both are set the token is ' +
            'used and your password is ignored.',
        );
      }

      // Before any auth reading: sign-in is the first thing that touches the
      // network, so an unreachable server surfaces here first and the SDK
      // labels it an authentication failure. Reclassify it.
      if (isNetworkFailure(error, message)) {
        throw new Error(unreachableMessage(config.serverURL));
      }

      if (message.includes('invalid-password')) {
        throw new Error(
          'Authentication failed: wrong password. ' +
          'Check ACTUAL_PASSWORD in your configuration. ' +
          'You can reset your password in Actual Budget under Settings > Server.',
        );
      }

      throw error;
    }

    try {
      await downloadBudgetWatchingMigrations(config.budgetId, config.encryptionPassword);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const code = errorCode(error);

      // Checked before anything else: this one masquerades as every other
      // failure, because the message it arrives with mentions a file rather
      // than a version.
      if ((error as { migrationsOutOfSync?: boolean })?.migrationsOutOfSync) {
        throw new Error(
          'Your Actual Budget is newer than the Actual library this server uses ' +
            `(${actualApiVersion()}), so it cannot open your budget: a budget migrated by a ` +
            'newer Actual needs a matching library. Nothing is wrong with your password, ' +
            'URL or Sync ID. Update actual-budget-mcp, or the Desktop Extension, to a ' +
            'version built against your Actual.',
        );
      }

      // Checked next: an unreachable server also throws an empty Error, and the
      // auth heuristic below would then read "no message and no password" as a
      // missing password. That sent people to check a password for an hour when
      // nothing was listening on the URL.
      if (isNetworkFailure(error, message)) {
        throw new Error(unreachableMessage(config.serverURL));
      }

      const isAuthError =
        message.includes('Could not get remote files') ||
        message.includes('unauthorized') ||
        code === 'unauthorized' ||
        (!message && !config.password); // API throws empty Error when sync fails without auth

      if (isAuthError) {
        if (!config.password) {
          throw new Error(
            'Could not authenticate with the Actual Budget server. ' +
            'Your server requires a password but ACTUAL_PASSWORD is not set. ' +
            'Set ACTUAL_PASSWORD where you configured this server: your MCP client config, or .env \n' +
            'if you installed from source.',
          );
        }
        throw new Error(
          'Authentication failed with the Actual Budget server. ' +
          'ACTUAL_PASSWORD may be incorrect. ' +
          'Check your password and try again.',
        );
      }

      if (message.includes('not found')) {
        throw new Error(
          `Budget "${config.budgetId}" not found on the server. ` +
          'Check ACTUAL_BUDGET_ID where you configured this server (MCP client config, or .env \n' +
          'if you installed from source). ' +
          'You can find your Sync ID in Actual Budget under Settings > Show advanced settings.',
        );
      }

      if (message.includes('encrypted') || message.includes('File') && message.includes('password')) {
        throw new Error(
          'Your budget file is encrypted. ' +
          'Set ACTUAL_ENCRYPTION_PASSWORD where you configured this server (MCP client config, \n' +
          'or .env if you installed from source).',
        );
      }

      throw error;
    }

    initialized = true;
  })();

  try {
    await initializing;
  } catch (error) {
    initializing = null;
    throw error;
  }
}

export async function shutdown(): Promise<void> {
  if (!initialized) return;
  await api.shutdown();
  // The claimed directory, not the configured one: they differ whenever this
  // server stepped aside, and releasing the wrong lock would drop someone
  // else's.
  releaseDataDirLock(claimedDataDir ?? effectiveDataDir());
  claimedDataDir = null;
  initialized = false;
  initializing = null;
  internal = null;
}

export { api };
