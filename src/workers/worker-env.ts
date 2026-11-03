import { readEnv } from '../utils/env.js';

/**
 * What a worker is started with, built rather than inherited (#229).
 *
 * A worker that inherited this process's environment would read
 * `ACTUAL_HTTP_PORT` and start an HTTP server of its own, on a port that is
 * taken, holding a budget nobody can reach. It would also be handed the
 * credentials for the front door and the encryption password of every other
 * budget, none of which it has any use for.
 *
 * So this is an allowlist and not a denylist, which is the direction that
 * survives: a denylist is a list of the mistakes somebody has already
 * thought of, and the next variable added to this server would be inherited
 * by default. Here it is absent until someone adds it.
 */

/** What any Node process needs to be a Node process. */
const PLATFORM = [
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'LANG',
  'LC_ALL',
  'TMPDIR',
  'TEMP',
  'TMP',
  'SystemRoot',
  'SystemDrive',
  'windir',
  'ComSpec',
  'APPDATA',
  'LOCALAPPDATA',
  'USERPROFILE',
  'PROGRAMFILES',
  'ProgramFiles(x86)',
  'PATHEXT',
  'NODE_OPTIONS',
  'NODE_EXTRA_CA_CERTS',
];

/**
 * The Actual settings a worker needs, and only those.
 *
 * `ACTUAL_READ_ONLY` passes down on purpose: a front end running read-only
 * starts children that are read-only too, so the write tools do not exist in
 * the process that holds the budget either. `ACTUAL_TOOLSET` passes for the
 * same reason, so a worker registers the same set the front offers.
 *
 * What is deliberately not here: `ACTUAL_HTTP_PORT` and the two HTTP tokens,
 * which would start a second server inside a worker and hand it the front
 * door's credentials; `ACTUAL_BUDGET_IDS`, because a worker serves one
 * budget and a list would make it think otherwise; and
 * `ACTUAL_ENCRYPTION_PASSWORDS`, the map, because each worker is given its
 * own password and nobody else's.
 */
const SHARED = [
  'ACTUAL_SERVER_URL',
  'ACTUAL_PASSWORD',
  'ACTUAL_SESSION_TOKEN',
  'ACTUAL_READ_ONLY',
  'ACTUAL_TOOLSET',
  'ACTUAL_HTTP_TIMEOUT_MS',
];

export interface WorkerEnvironment {
  budgetId: string;
  dataDir: string;
  encryptionPassword?: string;
}

export function workerEnvironment(options: WorkerEnvironment): Record<string, string> {
  const env: Record<string, string> = {};

  for (const name of [...PLATFORM, ...SHARED]) {
    const value = process.env[name];
    if (typeof value === 'string' && value !== '') env[name] = value;
  }

  env.ACTUAL_BUDGET_ID = options.budgetId;
  env.ACTUAL_DATA_DIR = options.dataDir;
  if (options.encryptionPassword !== undefined) {
    env.ACTUAL_ENCRYPTION_PASSWORD = options.encryptionPassword;
  }

  return env;
}

function parseMap(raw: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Said once at startup by `encryptionPasswordsProblem`, not here: this
    // runs per worker, and a broken map would otherwise be printed per
    // worker as well.
  }
  return undefined;
}

/**
 * The encryption password for one budget, out of the map or the single one.
 *
 * `ACTUAL_ENCRYPTION_PASSWORDS` is a JSON object keyed by sync id, because
 * budgets encrypted separately have separate passwords and one variable
 * cannot hold them. `ACTUAL_ENCRYPTION_PASSWORD` keeps working for the
 * budget in `ACTUAL_BUDGET_ID`, which is what a deployment with one budget
 * goes on using.
 *
 * The map is read here and never passed down: a worker's environment holds
 * its own password and nothing else.
 */
export function encryptionPasswordFor(budgetId: string): string | undefined {
  const raw = readEnv('ACTUAL_ENCRYPTION_PASSWORDS');
  if (raw !== undefined) {
    const found = parseMap(raw)?.[budgetId];
    if (typeof found === 'string' && found !== '') return found;
  }
  if (budgetId === readEnv('ACTUAL_BUDGET_ID')?.trim()) {
    return readEnv('ACTUAL_ENCRYPTION_PASSWORD');
  }
  return undefined;
}

/** What is wrong with the map, for the startup check. */
export function encryptionPasswordsProblem(): string | undefined {
  const raw = readEnv('ACTUAL_ENCRYPTION_PASSWORDS');
  if (raw === undefined) return undefined;
  if (parseMap(raw) === undefined) {
    return (
      'ACTUAL_ENCRYPTION_PASSWORDS is not a JSON object. It maps a budget sync id to ' +
      "that budget's encryption password, as {\"<sync id>\": \"<password>\"}."
    );
  }
  return undefined;
}
