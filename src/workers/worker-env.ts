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
  'NODE_EXTRA_CA_CERTS',
  // The clock. A worker in UTC while the front end is in its own zone gives
  // two different answers to "today", and a date is what half of these
  // tools are about: the Docker image sets TZ and nothing else would carry
  // it across.
  'TZ',
  // How this machine reaches the Actual server, which the worker is the one
  // doing now. Both cases of each, because the libraries that read them
  // disagree about which case they read.
  'HTTP_PROXY',
  'http_proxy',
  'HTTPS_PROXY',
  'https_proxy',
  'NO_PROXY',
  'no_proxy',
  // And who it is willing to believe once it gets there.
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
];

/**
 * `NODE_OPTIONS` passes, without the inspector.
 *
 * It carries things a deployment means for every process of this server,
 * `--max-old-space-size` above all, and a worker is the process that holds
 * the budget: leaving it behind would give the heap limit to the front end,
 * which needs it least.
 *
 * The inspector is the exception, because it is a port and not a setting.
 * Measured: a second process with `--inspect` prints `Starting inspector on
 * 127.0.0.1:9229 failed: address already in use` and runs on, so three
 * workers would each say it, prefixed with the budget they belong to, every
 * time somebody debugged the front end. Debugging a worker is
 * `ACTUAL_BUDGET_WORKERS=1` and a port of its own.
 */
const INSPECTOR = /(^|\s)--(inspect|debug)(-brk|-port|-publish-uid|-wait)?(=\S*)?(?=\s|$)/g;

function nodeOptions(): string | undefined {
  const raw = process.env.NODE_OPTIONS;
  if (typeof raw !== 'string' || raw === '') return undefined;
  const kept = raw.replace(INSPECTOR, ' ').replace(/\s+/g, ' ').trim();
  return kept === '' ? undefined : kept;
}

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

/**
 * The marker the pool puts in a worker's environment.
 *
 * Not configuration: nobody sets this, it is how a process started by the
 * pool knows it is one. A worker uses it to report its budget's name back
 * up the stdio pipe, which needs the `logging` capability declared, and
 * declaring that capability changes what `initialize` answers. Measured:
 * capabilities go from {"tools":{"listChanged":true}} to
 * {"logging":{},"tools":{"listChanged":true}}. So it is declared only here,
 * in processes the pool starts, and a server anybody else runs answers
 * exactly what it answered before.
 */
const MARKER = 'ACTUAL_MCP_WORKER';

/** Whether this process was started by a pool. */
export function startedByPool(): boolean {
  return readEnv(MARKER) === '1';
}

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

  const nodeFlags = nodeOptions();
  if (nodeFlags !== undefined) env.NODE_OPTIONS = nodeFlags;

  env[MARKER] = '1';
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
