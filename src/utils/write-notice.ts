import { describeError } from './errors.js';
import { lastFailedSync, lastGoodSync, lastReauthentication } from './sync-clock.js';
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
 */
export function syncFailureNotice(startedAt: number, now = Date.now()): string | undefined {
  const failed = lastFailedSync();
  const good = lastGoodSync();

  if (failed && (good === undefined || failed.at >= good)) {
    const reason = describeError(failed.error, { omitUncertainWriteCaution: true }).trim();
    const why = reason === '' ? '' : ` Reason: ${reason}`;
    return (
      'This is in the copy of the budget on this machine, and it did not reach the Actual ' +
      'server: the sync that pushes it failed. Nothing is lost, and the next sync that ' +
      'works will send it. Do not repeat the call to make it arrive, which would write it ' +
      `twice.${why}`
    );
  }

  const reauth = lastReauthentication();
  if (reauth !== undefined && reauth >= startedAt && reauth <= now) {
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
      const startedAt = Date.now();
      const result = await handler(...handlerArgs);
      const notice = syncFailureNotice(startedAt);
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
