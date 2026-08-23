/**
 * Keep a library-level promise rejection from taking the server down.
 *
 * #39: when `@actual-app/api` fails to download/sync the budget it rejects
 * promises that nothing awaits (e.g. inside its `api/download-budget`
 * handler). Node defaults to `--unhandled-rejections=throw` (since Node 15), so those
 * rejections killed the process a few seconds after boot — the client had
 * already completed the handshake and listed every tool, so the failure looked
 * like a mysterious "Connection closed", and reconnecting just repeated the
 * cycle. `src/index.ts` already intends to stay alive after a failed startup
 * validation so the error can reach the client on the first tool call; this
 * guard is what makes that intent hold.
 *
 * Injectable `proc`/`log` so the behaviour can be tested without a real crash.
 */
export function installProcessGuards(
  proc: NodeJS.Process = process,
  log: (message: string) => void = console.error,
): void {
  proc.on('unhandledRejection', (reason: unknown) => {
    // Log the raw reason, not the user-facing description: stderr is for
    // diagnosis, so the original wording (and the stack, when the message is
    // empty) is what makes the failure traceable.
    const raw =
      reason instanceof Error
        ? reason.message || reason.stack || String(reason)
        : String(reason);
    log(`Unhandled rejection (server staying alive): ${raw || '(no message)'}`);
  });
}
