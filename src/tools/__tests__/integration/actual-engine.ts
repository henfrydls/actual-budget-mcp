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
let internal: Awaited<ReturnType<typeof api.init>> | undefined;

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
  internal = await api.init({ dataDir });
}

/**
 * The engine's internal handlers, which `api.init` returns and the real
 * `connection.ts` hands out as `getInternal()`.
 *
 * A test that exercises code reaching for an internal handler mocks
 * `connection.js` and points `getInternal` here, so the handler is the real
 * one against the local budget. A test can also reach for one itself, to set
 * up something the public API does not expose, such as creating a schedule.
 */
export function testInternal(): Awaited<ReturnType<typeof api.init>> {
  if (!internal) throw new Error('the test engine is not initialised');
  return internal;
}

export async function shutdownTestEngine(): Promise<void> {
  try {
    await api.shutdown();
  } finally {
    if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
    dataDir = undefined;
    internal = undefined;
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
  // The decimal count belongs to the budget that is open, and a new budget
  // has its own currency. In the server this happens inside `ensureConnection`,
  // which reads the preference as part of opening one; here the harness opens
  // budgets itself, so without this a budget in yen would leave its count
  // behind for the next test to inherit.
  //
  // Imported here rather than at the top of the file, and that is load-order,
  // not style: `currency.ts` imports `connection.js`, and the tests that need
  // the engine's own handlers mock `connection.js` with a factory that imports
  // this file. A static import closes that circle and vitest waits on itself,
  // which hangs the run with no failure to read.
  const { resetBudgetDecimalPlaces } = await import('../../../utils/currency.js');
  resetBudgetDecimalPlaces();
  return created.id;
}

export { api };
