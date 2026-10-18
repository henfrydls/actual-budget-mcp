import { describeError, haystack } from './errors.js';
import { withSyncScope, type SyncScope } from './sync-clock.js';
import type { McpServerLike } from './read-sync.js';

/**
 * Say when a write did not reach the Actual server (#162).
 *
 * Actual writes to the local copy first and pushes on the next sync, so a
 * write whose sync fails is in the budget on this machine and nowhere else.
 * Measured against a disposable server with the session expired:
 * `create_payee` answered `isError: true`, and the payee was there. That
 * answer is the worst of both: the caller reads "Error", tries again, and
 * trying again is what duplicates.
 *
 * So `syncNow` stopped throwing, and this says what happened instead. Here
 * rather than in twenty-six write tools, for the reason #126 gave about the
 * reads: this is the place every reply goes through, and a tool added later
 * should not have to remember.
 *
 * It is added to the reply, never instead of it. What the tool wrote and what
 * it said about it are the answer; this is a caveat that belongs with it.
 *
 * Any failed sync, not only an expired session: a server that is down or a
 * network that is not there leave the write in exactly the same place.
 *
 * What it reads is this call's own scope and nothing wider. The first version
 * read the process-wide clock, which cannot say whose failure it is holding:
 * measured, a `create_transaction` that refused a duplicate and wrote nothing
 * still answered that the write had not reached the server and not to repeat
 * the call.
 */
const STAYED_HERE =
  'This is in the copy of the budget on this machine, and it did not reach the Actual ' +
  'server: the sync that pushes it failed. Nothing is lost, and the next sync that ' +
  'works will send it. Do not repeat the call to make it arrive, which would write it ' +
  'twice.';

/**
 * Why the session was not renewed, in the words of the case that happened.
 *
 * The general text covers all four at once, saying the sign-in "was tried and
 * did not work, or it has been tried too recently", and which one it was is
 * the only part the reader can act on. Measured against a disposable server
 * configured with the wrong password: Actual answered `invalid-password`, and
 * the reply never said so.
 */
function whyNotSignedIn(scope: SyncScope, now: number): string | undefined {
  const recovery = scope.recovery;
  if (recovery === undefined) return undefined;

  switch (recovery.outcome) {
    case 'refused':
      return (
        ' The session with the Actual server had expired and Actual refused the password ' +
        'this server is configured with, so it could not sign in again: check ' +
        'ACTUAL_PASSWORD where you configured this server.'
      );
    case 'no-password':
      return (
        ' The session with the Actual server had expired, and this server is configured ' +
        'with ACTUAL_SESSION_TOKEN rather than a password, so it has nothing to sign in ' +
        'with: issue a new token in Actual and set it there.'
      );
    case 'waiting': {
      // In minutes rather than a time of day: the reply is read somewhere
      // that need not share this machine's timezone, and "in 14 minutes"
      // cannot be read as the wrong hour.
      const minutes = Math.max(1, Math.ceil(((recovery.nextAttemptAt ?? now) - now) / 60_000));
      return (
        ' The session with the Actual server had expired. This server signs in again at ' +
        'most twice an hour and had done so recently, so it did not try this time; the ' +
        `next attempt is allowed in ${minutes} ${minutes === 1 ? 'minute' : 'minutes'}.`
      );
    }
    case 'failed':
      return (
        ' The session with the Actual server had expired and signing in again did not ' +
        `work either. Reason: ${describeError(recovery.error, {
          omitUncertainWriteCaution: true,
        }).trim()}`
      );
    default:
      return undefined;
  }
}

export function syncFailureNotice(scope: SyncScope, now = Date.now()): string | undefined {
  if (scope.failure !== undefined) {
    // The specific reason instead of the general one, not beside it: a
    // message that says the password was refused and then that the sign-in
    // may have been too recent teaches the reader to ignore both halves.
    const why = whyNotSignedIn(scope, now);
    if (why !== undefined) return STAYED_HERE + why;

    const signedIn =
      scope.reauthenticated === true
        ? ' The session with the Actual server had expired, so this server signed in ' +
          'again, and the sync failed even so.'
        : '';
    // The contention note only where contention can be the cause (#206).
    // Another server on the same budget is a fact about how this process
    // started; attached to `Reason:` it reads as the reason. In the live test
    // of 0.10.7 a push that failed against a stopped server ended on a
    // paragraph about a server from three weeks earlier, which had nothing to
    // do with it. An out-of-sync budget is the one failure here that two
    // servers really do cause, so that keeps it. The startup line says it
    // once in either case, where a fact about startup belongs.
    const outOfSync = /out-of-sync/i.test(haystack(scope.failure));
    const reason = describeError(scope.failure, {
      omitUncertainWriteCaution: true,
      omitContentionNote: !outOfSync,
    }).trim();
    return STAYED_HERE + signedIn + (reason === '' ? '' : ` Reason: ${reason}`);
  }

  if (scope.reauthenticated === true) {
    return (
      'The session with the Actual server had expired, so this server signed in again and ' +
      'the change reached the server on the second attempt.'
    );
  }

  return undefined;
}

/**
 * Wrap the write tools so each reply says whether it reached the server.
 *
 * `readOnlyHint` marks the reads, the same flag read-only mode uses, so a
 * tool is wrapped by one of the two and never by both.
 */
export function withWriteNotice<T extends McpServerLike>(server: T): T {
  const wrapped = Object.create(server) as T;

  const originalTool = server.tool.bind(server) as (...args: unknown[]) => unknown;
  (wrapped as { tool: unknown }).tool = (...args: unknown[]) => {
    const annotations = args.find(
      (a): a is { readOnlyHint?: boolean } =>
        typeof a === 'object' && a !== null && 'readOnlyHint' in a,
    );
    if (annotations?.readOnlyHint === true) return originalTool(...args);

    const handler = args[args.length - 1] as (
      ...handlerArgs: unknown[]
    ) => Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }>;

    const wrappedHandler = async (...handlerArgs: unknown[]) => {
      // The scope is opened here, around the handler, so what it holds is
      // this call's syncs and no one else's.
      const { result, scope } = await withSyncScope(() => handler(...handlerArgs));
      const notice = syncFailureNotice(scope);
      // An error already says something went wrong, and nothing was written
      // to warn about; two problems in one reply send the reader looking for
      // two fixes.
      if (!notice || result.isError) return result;

      const content = [...result.content];
      const last = content[content.length - 1];
      if (last && last.type === 'text') {
        content[content.length - 1] = { ...last, text: `${last.text}\n\n${notice}` };
      } else {
        content.push({ type: 'text', text: notice });
      }
      return { ...result, content };
    };

    return originalTool(...args.slice(0, -1), wrappedHandler);
  };

  return wrapped;
}
