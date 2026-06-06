import * as api from '@actual-app/api';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Integration test harness that runs the REAL Actual Budget engine locally,
 * with no server and a throwaway data directory. Nothing here ever touches a
 * real server or budget — each run creates a fresh local budget and the temp
 * directory is removed on teardown.
 *
 * This is what proves behavior that mocks cannot, e.g. that the SDK overrides an
 * explicit category with a learned payee→category mapping (#26).
 */

let dataDir: string | undefined;
let originalLog: typeof console.log | undefined;

// The engine emits informational "[Breadcrumb]" / spreadsheet chatter on stdout.
// Filter it so test output stays focused on assertions (real errors still pass through).
function silenceEngineChatter(): void {
  originalLog = console.log;
  console.log = (...args: unknown[]) => {
    const first = args[0];
    if (typeof first === 'string' && (first.includes('[Breadcrumb]') || first.includes('spreadsheet'))) {
      return;
    }
    originalLog!(...args);
  };
}

function restoreLog(): void {
  if (originalLog) {
    console.log = originalLog;
    originalLog = undefined;
  }
}

export async function initTestEngine(): Promise<void> {
  silenceEngineChatter();
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'actual-mcp-it-'));
  await api.init({ dataDir });
}

export async function shutdownTestEngine(): Promise<void> {
  try {
    await api.shutdown();
  } finally {
    if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
    dataDir = undefined;
    restoreLog();
  }
}

let counter = 0;

/**
 * Create a fresh local budget and return its sync id.
 *
 * `setup` runs inside the import session (budget active), where callers seed
 * accounts/categories and any learned payee→category mappings. The budget is
 * then reloaded from disk so persisted learning is re-activated, mirroring how
 * a real session behaves.
 */
export async function createFreshBudget(
  setup: () => Promise<void> = async () => {},
  prefix = 'it',
): Promise<string> {
  const name = `${prefix}-${Date.now()}-${counter++}`;
  await api.runImport(name, setup);
  const budgets = await api.getBudgets();
  const created = budgets.find((b) => b.name === name);
  if (!created) throw new Error(`could not locate freshly created budget "${name}"`);
  await api.loadBudget(created.id);
  return created.id;
}

export { api };
