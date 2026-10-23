import * as api from '@actual-app/api';
import type { ConnectionConfig } from './types.js';
import {
  activeDataDir,
  claimDataDir,
  crowdedNotice,
  forgetActiveDataDir,
  releaseDataDirLock,
  effectiveDataDir,
  ensureDataDirExists,
} from './utils/data-dir-lock.js';
import { packageVersion, actualApiVersion } from './utils/version.js';
import { readEnv } from './utils/env.js';
import { refreshBudgetDecimalPlaces, resetBudgetDecimalPlaces } from './utils/currency.js';
import { withoutCredentials } from './utils/redact.js';
import { serverUrlProblem } from './utils/server-url.js';

let initialized = false;
let initializing: Promise<void> | null = null;
/**
 * Whether `api.init` got as far as signing in.
 *
 * Not the same question as `initialized`, which is only true once the budget
 * is open: a startup that fails on the download has a session on the server
 * and a claimed directory, and both are this process's to give back (#219).
 */
let signedIn = false;
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

  // Here as well as at startup (#275). The entry point refuses to come up
  // with credentials in the address, and this is the same refusal for
  // anything that reaches a connection another way: a test, a library
  // consumer, a future entry point. It is cheap and it is the difference
  // between one clear error and every call answering that nothing is
  // listening.
  const problem = serverUrlProblem(serverURL);
  if (problem !== undefined) throw new Error(problem);

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
 *
 * Exported for its test and for no other caller. The address it is given can
 * no longer carry credentials, because `getConfig` refuses those before any
 * of this runs, so the redaction in it is a second line that the first line
 * keeps out of reach: a test of the path cannot get here, and a test of the
 * function can.
 */
export function unreachableMessage(serverURL: string): string {
  const portHint = serverURL.includes(':5006')
    ? ' If you use the Actual desktop app rather than a self-hosted server, try port 5007 instead: the app runs its own server there, and only while the app is open.'
    : serverURL.includes(':5007')
      ? " Port 5007 is the desktop app's own server, which only runs while the app is open. Open Actual and try again, or use 5006 if you meant a self-hosted server."
      : '';

  return (
    `Could not reach the Actual Budget server at ${withoutCredentials(serverURL)}. ` +
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
/**
 * What to say when the budget is newer than the library that has to open it.
 *
 * One text for both routes below, because there are two and they used to
 * disagree by one existing and the other not.
 */
/**
 * What the engine says on its way to not opening the budget.
 *
 * `loadBudget` returns `{ error: <code> }` and `downloadBudget` **discards the
 * value** (`await loadBudget$1({ id })` in the bundle), so the code never
 * reaches a caller. Some of those paths log on their way out and some do not,
 * which is why the budget being open is checked separately below: the markers
 * improve the message, they are not what detects the failure.
 */
const ENGINE_MARKERS = [
  { marker: 'out-of-sync-migrations', kind: 'migrations' },
  { marker: 'out-of-sync-data', kind: 'data' },
  { marker: 'Error updating budget', kind: 'loading' },
  // Not a code of its own: the engine answers `opening-budget` without logging
  // it, and this is what SQLite says underneath when the cached file is not a
  // database.
  { marker: 'SQLITE_NOTADB', kind: 'corrupt' },
  { marker: 'file is not a database', kind: 'corrupt' },
] as const;

type FailureKind = (typeof ENGINE_MARKERS)[number]['kind'];

/**
 * Replace anything the user configured as a secret before quoting the engine.
 *
 * The line this quotes goes three places that are all wrong for a password:
 * the tool reply, which the model reads; stderr, which a host writes to a log
 * file; and the text the message asks the person to paste into a public issue.
 * The engine builds its own error strings and has pasted a URL with
 * credentials in it before now, so the quote is filtered rather than trusted.
 *
 * Only values actually configured are replaced, longest first so a token that
 * contains the password does not leave the tail behind. Short values are left
 * alone: a one or two character secret would match half the sentence, and
 * redacting the whole line would hide the thing it was quoted for.
 */
function redactSecrets(line: string): string {
  const secrets = [
    process.env.ACTUAL_PASSWORD,
    process.env.ACTUAL_SESSION_TOKEN,
    process.env.ACTUAL_ENCRYPTION_PASSWORD,
  ]
    .filter((value): value is string => typeof value === 'string' && value.length >= 4)
    .sort((a, b) => b.length - a.length);

  let out = line;
  for (const secret of secrets) out = out.split(secret).join('***');
  return out;
}

/** Where the cached copy lives, which is what the reader has to delete. */
function cacheHint(): string {
  return claimedDataDir
    ? `the budget's folder inside ${claimedDataDir}`
    : 'the budget\'s folder inside your ACTUAL_DATA_DIR';
}

/**
 * Why the budget did not open, and what to do about it.
 *
 * One text per cause, because the two likely ones need opposite actions and an
 * earlier version named only the first. `out-of-sync-migrations` is no longer
 * only a version gap: from 26.10 the engine accepts unknown migrations past its
 * cutoff, so the same code now also means a local copy that is missing a
 * migration it should have. Telling that person to update the server sends
 * them nowhere; what fixes it is deleting the cached copy.
 *
 * It does not say the budget is undamaged. On the inconsistent-cache path the
 * local copy *is* damaged, and the previous wording promised otherwise.
 */
function loadFailureMessage(
  kind: FailureKind | undefined,
  detail: string | undefined,
  /** Set when the read itself failed: the database answered, with this. */
  why?: string,
): string {
  const version = actualApiVersion();
  // Only the branch that offers two remedies asks which one fits. The others
  // offer one, so the question would be asking the reader to choose between a
  // single thing.
  const report =
    ' If neither fits, please say so at ' +
    'https://github.com/henfrydls/actual-budget-mcp/issues with this message.';
  const pleaseReport =
    ' Please report this at https://github.com/henfrydls/actual-budget-mcp/issues with ' +
    'this message.';

  // The database answered, and what it said is the thing to act on. Sending
  // this person to delete their cache would destroy a healthy copy over a lock
  // that clears on its own: `SQLITE_BUSY: database is locked` means another
  // process has it open, not that anything is wrong with it.
  if (why) {
    return (
      'This server could not read your budget. The database answered: ' +
      `${redactSecrets(why)}. Nothing is wrong with your password, URL or Sync ID. If ` +
      'another program has the budget open -- the Actual app, or a second copy of this ' +
      'server on the same ACTUAL_DATA_DIR -- close it and try again.' +
      pleaseReport
    );
  }

  switch (kind) {
    case 'migrations':
      return (
        `This server could not open your budget. Its Actual library is ${version}, and the ` +
        'budget has migrations that version does not recognise. Two things cause that, and ' +
        'they need opposite fixes. Either your Actual is newer than this server, in which ' +
        'case update actual-budget-mcp or the Desktop Extension to a version built against ' +
        `it. Or the local copy is inconsistent, in which case delete ${cacheHint()} so it ` +
        'is downloaded again. Nothing is wrong with your password, URL or Sync ID, and the ' +
        'budget on your server is untouched either way.' +
        pleaseReport
      );
    case 'data':
      return (
        'This server could not open your budget: the local copy has drifted out of sync ' +
        `with your server. Delete ${cacheHint()} so it is downloaded again. Nothing is ` +
        'wrong with your password, URL or Sync ID, and the budget on your server is ' +
        'untouched.' +
        pleaseReport
      );
    case 'corrupt':
      return (
        'This server could not open your budget: the cached copy is not a readable ' +
        `database. Delete ${cacheHint()} so it is downloaded again. The budget on your ` +
        'server is untouched.' +
        pleaseReport
      );
    case 'loading':
      return (
        'This server downloaded your budget but could not finish opening it. Delete ' +
        `${cacheHint()} so it is downloaded again. The budget on your server is untouched.` +
        pleaseReport
      );
    default:
      // Nothing recognised. Saying so, with whatever the engine did say, beats
      // "No budget file is open" -- which is what the user in #139 had, and
      // their complaint was that nothing said why.
      //
      // No "if neither fits" here: there is only one remedy to offer, so the
      // phrase would be asking the reader to choose between one thing.
      return (
        'This server connected to your Actual server but the budget did not open, and the ' +
        'reason is not one it recognises. Your password, URL and Sync ID are fine, or the ' +
        `connection would have failed earlier. Deleting ${cacheHint()} so it is downloaded ` +
        'again is the usual fix.' +
        (detail
          ? ` The engine said: ${redactSecrets(detail)}.`
          : ' The engine said nothing at all.') +
        pleaseReport
      );
  }
}

/** Says it on stderr as well, because the tool reply is not always read. */
function reportLoadFailure(
  kind: FailureKind | undefined,
  detail: string | undefined,
  why?: string,
): Error {
  const message = loadFailureMessage(kind, detail, why);
  // stderr: stdout carries JSON-RPC.
  console.error(`[actual-budget-mcp] ${message}`);
  return new Error(message);
}

interface DownloadOutcome {
  /** The first marker recognised, if any. */
  kind?: FailureKind;
  /** A line from the engine, for the message of last resort. */
  detail?: string;
}

async function downloadBudgetWatchingMigrations(
  budgetId: string,
  encryptionPassword: string | undefined,
): Promise<DownloadOutcome> {
  const outcome: DownloadOutcome = {};
  const seen = (args: unknown[]) => {
    const line = args.map((a) => String(a)).join(' ');
    for (const { marker, kind } of ENGINE_MARKERS) {
      if (line.includes(marker)) {
        outcome.kind ??= kind;
        outcome.detail ??= line.slice(0, 300);
        return;
      }
    }
    // Keep the first line that looks like trouble even when no marker matches.
    //
    // Without this, `detail` was only ever set alongside `kind`, so the one
    // message that exists to repeat what the engine said always ended with
    // "The engine said nothing at all" — including on the `budget-not-found`
    // path, where the engine had said `[Exception] Error: budget directory
    // does not exist`. That is the complaint in #139 reproduced by the code
    // meant to answer it.
    if (/\b(error|exception|failed|cannot|unable)\b/i.test(line)) {
      outcome.detail ??= line.slice(0, 300);
    }
  };

  const originals = { log: console.log, error: console.error, warn: console.warn };
  console.log = (...args: unknown[]) => { seen(args); originals.log(...args); };
  console.error = (...args: unknown[]) => { seen(args); originals.error(...args); };
  console.warn = (...args: unknown[]) => { seen(args); originals.warn(...args); };

  try {
    await api.downloadBudget(budgetId, { password: encryptionPassword });
    return outcome;
  } catch (error) {
    (error as { loadOutcome?: DownloadOutcome }).loadOutcome = outcome;
    throw error;
  } finally {
    console.log = originals.log;
    console.error = originals.error;
    console.warn = originals.warn;
  }
}

/**
 * Whether a budget is actually open, rather than whether downloading threw.
 *
 * This is what detects the failure. The engine returns its reason and
 * `downloadBudget` throws it away, so there is no error to inspect and some of
 * the paths log nothing at all: #139 was a server that believed it had
 * connected and a first tool call answering `No budget file is open`.
 *
 * `getBudgetMonths` is the cheapest read that needs an open budget and touches
 * nothing.
 */
async function budgetIsOpen(): Promise<{ open: boolean; why?: string }> {
  try {
    await api.getBudgetMonths();
    return { open: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // Only this one means "nothing is loaded". Anything else is a different
    // problem wearing the same clothes: a locked database answers
    // `SQLITE_BUSY: database is locked`, and treating that as "no budget" told
    // the reader to delete a perfectly good cache while losing the one line
    // that said what was actually wrong.
    if (message.includes('No budget file is open')) return { open: false };
    return { open: false, why: message.slice(0, 300) };
  }
}

/** Long enough for any server that is going to answer, short enough to not matter. */
const VERSION_CHECK_TIMEOUT_MS = 5_000;

/**
 * Warn before opening a budget this library would migrate past its server.
 *
 * Opening a budget runs any migration the library has and the file does not,
 * and the next sync pushes the result. So a 26.10 library against a 26.9
 * server quietly takes the budget somewhere the user's own 26.9 app can no
 * longer follow: measured, 59 migrations become 60, and a 26.9 client
 * downloading from scratch then fails exactly the way #139 did.
 *
 * Actual's own 26.10 client does the same thing, so this is not a fault to
 * refuse -- it is a consequence nobody is told about. Hence a warning rather
 * than a block: refusing would strand anyone deliberately on an older server,
 * and the migration is what makes the budget readable at all here.
 *
 * Only the minor is compared. Actual releases month.minor and the migrations
 * come with those; a patch has never carried one.
 */
async function warnIfServerIsOlder(): Promise<void> {
  let serverVersion: string | undefined;
  try {
    // On a deadline of its own. `getServerVersion` is a plain fetch with no
    // timeout inside the SDK, and this runs before the budget is downloaded:
    // a server that accepts the connection and never answers would hang the
    // whole startup here, on a warning nobody asked for. The global fetch
    // deadline (#99) covers the request, but not a promise that never settles
    // for some other reason, so the race is belt and braces.
    // The timer is cleared whichever side wins. Left running, it keeps the
    // event loop alive for its full five seconds after everything else is
    // done, which `test:connection` pays for on every successful run.
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const reported = (await Promise.race([
        api.getServerVersion(),
        new Promise((resolve) => {
          timer = setTimeout(() => resolve(undefined), VERSION_CHECK_TIMEOUT_MS);
        }),
      ])) as { version?: string } | undefined;
      serverVersion = reported?.version;
    } finally {
      if (timer) clearTimeout(timer);
    }
  } catch {
    // Not every server answers this, and a missing version is not a reason to
    // refuse to work.
    return;
  }
  if (!serverVersion) return;

  const parts = (v: string) => v.split('.').map(Number);
  const [serverMajor, serverMinor] = parts(serverVersion);
  const [libMajor, libMinor] = parts(actualApiVersion());
  if (![serverMajor, serverMinor, libMajor, libMinor].every(Number.isFinite)) return;

  const older = serverMajor < libMajor || (serverMajor === libMajor && serverMinor < libMinor);
  if (!older) return;

  // stderr: stdout carries JSON-RPC.
  console.error(
    `[actual-budget-mcp] your Actual server is ${serverVersion} and this server's Actual ` +
      `library is ${actualApiVersion()}. Opening your budget here will migrate it to the ` +
      'newer format and the next sync will upload that, after which an Actual app still on ' +
      `${serverVersion} can no longer open it. Actual's own apps do this too when they ` +
      'update. Update your Actual server and apps to match, or stop this server now.',
  );
}

/**
 * How long to leave the server alone between sign-ins.
 *
 * Measured against a disposable Actual server: `/login` allows five failed
 * attempts per fifteen minutes and then answers 429 `too-many-requests`,
 * counting only the failures (`skipSuccessfulRequests`). A 429 is worse than
 * the failure it replaces, because it hides `invalid-password` behind an
 * answer about rate limits, so this stays well clear: twenty minutes apart
 * and at most two in an hour, which cannot reach five in fifteen.
 */
const REAUTH_GAP_MS = 20 * 60_000;
const REAUTH_MAX_PER_HOUR = 2;
let reauthAt: number[] = [];
let reauthenticating: Promise<Reauthentication> | null = null;

export type ReauthOutcome =
  | 'signed-in'
  /** Configured with a token, so there is nothing to sign in with. */
  | 'no-password'
  /** Too soon, or too many lately. */
  | 'waiting'
  /** The server said the password is wrong. */
  | 'refused'
  | 'failed';

/**
 * What signing in again did, in enough detail to say it out loud.
 *
 * The outcome on its own was not enough. A write whose sync failed said the
 * sign-in "was tried and did not work, or has been tried too recently",
 * covering four cases at once, while this function knew which one it was:
 * measured against a disposable server with the wrong password, the reply
 * never once said the password had been refused.
 */
export interface Reauthentication {
  outcome: ReauthOutcome;
  /** What Actual answered when the sign-in itself failed. */
  error?: unknown;
  /** The earliest the next attempt is allowed, for `waiting`. */
  nextAttemptAt?: number;
}

/** For tests: forget the attempts, as if the process had just started. */
export function resetReauthClock(): void {
  reauthAt = [];
  reauthenticating = null;
}

/**
 * Sign in again after the session with the Actual server expired (#162).
 *
 * Through `api.init`, which is the same public call the server makes at
 * startup, rather than the engine's internal sign-in handler: measured, it
 * can be called a second time in one process, and the budget stays open, so
 * the sync that follows works. That also keeps this off an internal API that
 * can change between releases.
 *
 * Only with a password. With `ACTUAL_SESSION_TOKEN` there is nothing to sign
 * in with: the only thing that path offers is setting the token you already
 * have, and the one you have is the expired one.
 *
 * What a sign-in leaves on the server depends on the version, and both were
 * measured against a disposable server (#219):
 *
 *   - Up to 26.10 the row for a password login is reused, token and all, so
 *     four sign-ins leave one session.
 *   - From 26.11 each sign-in makes its own row, with its own token and
 *     `expires_at = -1`, which nothing ever clears: four sign-ins leave four.
 *     A new one does not revoke the old ones, measured, so signing in again
 *     here cannot knock another server off its session.
 *
 * That makes the limits above do a second job from 26.11: twice an hour is
 * also how many rows a server that keeps losing its session can leave behind.
 * Nothing is left behind by the sign-in itself, though, because the session
 * being replaced is one the server has already revoked or deleted: that is
 * why we are here. Measured, deleting our row and signing in again moves the
 * count by exactly one.
 *
 * And measured on an **encrypted** budget, because `api.init` reloads the
 * global store and the encryption keys live in it: against a disposable
 * server holding an end-to-end encrypted file, with the session expired, the
 * write that followed the sign-in reached the server, and a third, clean data
 * directory downloaded the file with the encryption password and read it
 * back. The keys are written to `global-store.json` when the file is first
 * decrypted, which is where the new store finds them.
 */
export async function reauthenticate(): Promise<Reauthentication> {
  if (reauthenticating) return reauthenticating;

  const config = getConfig();
  if (config.sessionToken || !config.password) return { outcome: 'no-password' };

  const now = Date.now();
  reauthAt = reauthAt.filter((at) => now - at < 60 * 60_000);
  if (reauthAt.length >= REAUTH_MAX_PER_HOUR) {
    // Both limits bind at once: the oldest attempt has to age out of the hour
    // *and* the gap since the last one has to pass.
    return {
      outcome: 'waiting',
      nextAttemptAt: Math.max(reauthAt[0] + 60 * 60_000, reauthAt[reauthAt.length - 1] + REAUTH_GAP_MS),
    };
  }
  if (reauthAt.length > 0 && now - reauthAt[reauthAt.length - 1] < REAUTH_GAP_MS) {
    return { outcome: 'waiting', nextAttemptAt: reauthAt[reauthAt.length - 1] + REAUTH_GAP_MS };
  }

  reauthAt.push(now);
  reauthenticating = (async () => {
    try {
      await api.init({
        // The directory this process holds, not the configured one: #71 can
        // have stepped aside to a sibling, and signing in against the other
        // one would open a second copy of the budget. `activeDataDir` is
        // where that answer already lives, and asking it is what keeps this
        // from being a second opinion that can disagree.
        dataDir: activeDataDir(),
        serverURL: config.serverURL,
        password: config.password,
      });
      return { outcome: 'signed-in' as const };
    } catch (error) {
      return {
        outcome: errorCode(error) === 'invalid-password' ? ('refused' as const) : ('failed' as const),
        error,
      };
    } finally {
      reauthenticating = null;
    }
  })();
  return reauthenticating;
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
      // How many there are, since when, and what it costs (#207). The line
      // used to name the directory and the first pid, which says nothing
      // about the pile: a server several siblings along has that many others
      // running, and "<dir> is in use" gives the reader no way to know.
      const crowded = crowdedNotice(claim);
      console.error(
        crowded !== undefined
          ? `[actual-budget-mcp] ${crowded}`
          : `[actual-budget-mcp] ${claim.contended} is in use, so this server is using ` +
              `${dataDir} instead. The first run here downloads the budget again; set ` +
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
      // From here there is a session on the server, whatever happens next.
      signedIn = true;
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

    // Before the download, because the download is what migrates it.
    await warnIfServerIsOlder();

    try {
      const outcome = await downloadBudgetWatchingMigrations(
        config.budgetId,
        config.encryptionPassword,
      );
      // The route this actually takes, measured against a 26.10 budget with the
      // 26.9 library (#139): `downloadBudget` does **not** throw. It logs the
      // reason, discards the code `loadBudget` handed it, and resolves — so
      // `ensureConnection` returned normally and the first tool answered `No
      // budget file is open`, a message about a file for a version problem.
      //
      // So the budget being open is checked rather than assumed. Not the
      // markers: some of those paths log nothing at all (`opening-budget` and
      // `budget-not-found` return without a line), and a server that believes
      // it connected is the whole failure. The markers only choose the wording.
      const open = await budgetIsOpen();
      if (!open.open) {
        // `why` wins over the console: it is what the read itself said, which
        // beats a line scraped from a log, and it needs its own wording --
        // a database that answered is not a cache to delete.
        throw reportLoadFailure(outcome.kind, outcome.detail, open.why);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const code = errorCode(error);

      // Checked before anything else: this one masquerades as every other
      // failure, because the message it arrives with mentions a file rather
      // than a version.
      const loadOutcome = (error as { loadOutcome?: DownloadOutcome })?.loadOutcome;
      if (loadOutcome?.kind) {
        throw reportLoadFailure(loadOutcome.kind, loadOutcome.detail);
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

    // With the budget open, and before any tool can convert a figure: every
    // amount in and out is scaled by the currency's decimal count, and the
    // default is wrong for a budget in one that has none (#141). It reads
    // nothing over the network and cannot throw, so a budget whose preference
    // is unreadable connects exactly as before, with the default.
    await refreshBudgetDecimalPlaces();

    initialized = true;
  })();

  try {
    await initializing;
  } catch (error) {
    initializing = null;
    // A startup that signed in and then failed leaves a session on the
    // server, and from Actual 26.11 that row never expires. The next tool
    // call tries again and makes another: measured against a disposable
    // server whose download was cut, three calls took the count from 20 to
    // 26, and only the last was ever closed. So it is closed here, before
    // the error goes back to the caller.
    //
    // `api.shutdown` and not this module's, which also gives back the data
    // directory: this process is still running and still holds it.
    if (signedIn) {
      signedIn = false;
      internal = null;
      try {
        await api.shutdown();
      } catch {
        // The session is the only thing being given back, and a server that
        // cannot be reached is why we are here.
      }
    }
    throw error;
  }
}

/**
 * Resolves once a connection being established has settled, either way.
 *
 * The exit waits on this along with the tool calls (#219): `api.init` signs
 * in at the start of a download that can take minutes, so a client that
 * leaves during one has a session on the server and nothing has finished
 * that would let us close it.
 *
 * It is bounded by whoever is leaving, and that bound is the honest limit of
 * this: a download longer than it still leaves the session open. There is no
 * way to close one from here without the token, and the token is inside the
 * engine's own store.
 */
export async function connectionSettled(): Promise<void> {
  if (initializing) await initializing.catch(() => undefined);
}

export async function shutdown(): Promise<void> {
  // A client can go away while the budget is still opening: the first
  // download takes minutes and `initialized` is only set at the end of it.
  // By then `api.init` has already signed in, so there is a session on the
  // server that this process made, and leaving on "nothing to close" is what
  // strands it. Measured against a disposable 26.11 server: ending stdin
  // during startup left a session row behind every time.
  //
  // Whoever is leaving puts a limit on how long this may take, so joining a
  // connection in flight cannot hold the exit open.
  if (initializing) await initializing.catch(() => undefined);
  // `signedIn`, not only `initialized`: a startup that signed in and then
  // failed on the download leaves a session on the server and a claimed
  // directory, and reading "not initialised" as "nothing to give back"
  // stranded both (#219).
  if (!initialized && !signedIn) return;
  await api.shutdown();
  // The claimed directory, not the configured one: they differ whenever this
  // server stepped aside, and releasing the wrong lock would drop someone
  // else's.
  releaseDataDirLock(claimedDataDir ?? effectiveDataDir());
  claimedDataDir = null;
  forgetActiveDataDir();
  resetBudgetDecimalPlaces();
  initialized = false;
  signedIn = false;
  initializing = null;
  internal = null;
}

export { api };
