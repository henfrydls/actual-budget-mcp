import * as api from '@actual-app/api';
import type { ConnectionConfig } from './types.js';

let initialized = false;
let initializing: Promise<void> | null = null;

function getConfig(): ConnectionConfig {
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

    try {
      await api.init({
        dataDir: config.dataDir || '/tmp/actual-budget-mcp-data',
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
          'If you use a remote server, check that ACTUAL_SERVER_URL is correct in your .env file.',
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
            'Set ACTUAL_PASSWORD in your .env file or environment variables.',
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
          'Check ACTUAL_BUDGET_ID in your .env file. ' +
          'You can find your Sync ID in Actual Budget under Settings > Show advanced settings.',
        );
      }

      if (message.includes('encrypted') || message.includes('File') && message.includes('password')) {
        throw new Error(
          'Your budget file is encrypted. ' +
          'Set ACTUAL_ENCRYPTION_PASSWORD in your .env file with the encryption password.',
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
  initialized = false;
  initializing = null;
}

export { api };
