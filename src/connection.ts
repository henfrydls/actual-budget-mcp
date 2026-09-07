import * as api from '@actual-app/api';
import type { ConnectionConfig } from './types.js';
import {
  acquireDataDirLock,
  releaseDataDirLock,
  effectiveDataDir,
  ensureDataDirExists,
} from './utils/data-dir-lock.js';
import { packageVersion } from './utils/version.js';

let initialized = false;
let initializing: Promise<void> | null = null;

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
  const serverURL = process.env.ACTUAL_SERVER_URL;
  const password = process.env.ACTUAL_PASSWORD;
  const budgetId = process.env.ACTUAL_BUDGET_ID;

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
    budgetId,
    encryptionPassword: process.env.ACTUAL_ENCRYPTION_PASSWORD,
    dataDir: process.env.ACTUAL_DATA_DIR,
  };
}

export async function ensureConnection(): Promise<void> {
  if (initialized) return;

  if (initializing) {
    await initializing;
    return;
  }

  initializing = (async () => {
    const config = getConfig();
    const dataDir = effectiveDataDir();
    // Before anything else: api.init() tolerates a missing directory but
    // downloadBudget() then dies with a bare ENOENT that masks every other
    // diagnostic.
    ensureDataDirExists(dataDir);

    // #47: advisory only — never refuse to start. Two servers on one data dir
    // drive the budget out-of-sync, so warn early and let describeError name
    // the other process if something does fail later.
    const lock = acquireDataDirLock(dataDir, packageVersion);
    if (!lock.acquired && lock.heldBy) {
      // stderr: stdout carries JSON-RPC.
      console.error(
        `[actual-budget-mcp] warning: another server (pid ${lock.heldBy.pid}) is already ` +
          `using ${dataDir}. Sharing a data dir puts the budget out of sync — ` +
          'give each client its own ACTUAL_DATA_DIR.',
      );
    }

    try {
      internal = await api.init({
        dataDir,
        serverURL: config.serverURL,
        password: config.password,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const reason = (error as any)?.reason || '';

      if (message.includes('network-failure') || reason === 'network-failure' || message.includes('ECONNREFUSED') || message.includes('fetch failed')) {
        throw new Error(
          `Could not connect to Actual Budget server at ${config.serverURL}. ` +
          'Make sure the Actual Budget app is running and the URL is correct. ' +
          'If you use Actual Budget as a desktop app, open it first. ' +
          'If you use a remote server, check ACTUAL_SERVER_URL where you configured this server \n' +
          '(your MCP client config, or .env if you installed from source).',
        );
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
      await api.downloadBudget(config.budgetId, {
        password: config.encryptionPassword,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const reason = (error as any)?.reason || '';
      // Checked first: an unreachable server also throws an empty Error, and the
      // auth heuristic below would then read "no message and no password" as a
      // missing password. That sent people to check a password for an hour when
      // nothing was listening on the URL.
      const isNetworkError =
        reason === 'network-failure' ||
        message.includes('network-failure') ||
        message.includes('ECONNREFUSED') ||
        message.includes('fetch failed');

      if (isNetworkError) {
        throw new Error(
          `Could not reach the Actual Budget server at ${config.serverURL}. ` +
            'Nothing answered on that address, so this is not a password or budget problem. ' +
            'Check that the server is running and that ACTUAL_SERVER_URL points at it ' +
            '(if you run Actual as a desktop app, open it first).',
        );
      }

      const isAuthError =
        message.includes('Could not get remote files') ||
        message.includes('unauthorized') ||
        reason === 'unauthorized' ||
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
  releaseDataDirLock(effectiveDataDir());
  initialized = false;
  initializing = null;
  internal = null;
}

export { api };
