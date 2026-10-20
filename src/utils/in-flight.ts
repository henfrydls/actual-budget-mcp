import type { McpServerLike } from './read-sync.js';

/**
 * How many tool calls are running right now (#219).
 *
 * Leaving used to mean calling `shutdown()` the moment the client went away,
 * which runs it beside whatever a tool is in the middle of. Measured against
 * a disposable server: a batch of three thousand rows with a signal sent
 * 300ms in answered `Error: No budget file is open` and wrote all three
 * thousand anyway, which is the worst pair of answers there is. A tool that
 * writes in several steps could be cut between two of them.
 *
 * So the exit waits for what is in flight before it closes anything. Counted
 * here, in the wrapper every tool call already goes through, because a tool
 * added later should not have to remember.
 */
let active = 0;
let waiting: Array<() => void> = [];
let leaving = false;

function settle(): void {
  if (active !== 0) return;
  const waking = waiting;
  waiting = [];
  for (const wake of waking) wake();
}

/** Run a tool call, counted while it runs. */
export async function trackInFlight<T>(run: () => Promise<T>): Promise<T> {
  active += 1;
  try {
    return await run();
  } finally {
    active -= 1;
    settle();
  }
}

/** How many are running, for a test to read rather than infer. */
export function inFlightCount(): number {
  return active;
}

/** Resolves when nothing is running. Immediately when nothing is. */
export function whenIdle(): Promise<void> {
  if (active === 0) return Promise.resolve();
  return new Promise<void>((resolve) => waiting.push(resolve));
}

/**
 * Stop taking new work, because this server is on its way out (#219).
 *
 * Measured: Claude Code closes a stdio server with SIGINT, then SIGTERM
 * 100ms later, then SIGKILL 400ms after that. Five hundred milliseconds in
 * total, and signing out of the server has to fit inside it. Anything spent
 * looking at whether a request is about to arrive is taken from that.
 *
 * So a call that arrives once leaving has begun is refused outright, which
 * is both faster and more honest than letting it reach a budget that is
 * being closed: before this, a request that had not been dispatched yet
 * answered `Error: No budget file is open` and wrote its rows anyway.
 */
export function startLeaving(): void {
  leaving = true;
}

export function isLeaving(): boolean {
  return leaving;
}

/** For tests: forget everything, as if the process had just started. */
export function resetInFlight(): void {
  active = 0;
  waiting = [];
  leaving = false;
}

/**
 * Count every tool call, whichever direction it goes.
 *
 * Outermost of the wrappers, so what it counts is the whole call including
 * the notices the others add: the question it answers is "is this server in
 * the middle of something", and a reply still being written is.
 */
export function withInFlight<T extends McpServerLike>(server: T): T {
  const wrapped = Object.create(server) as T;

  const originalTool = server.tool.bind(server) as (...args: unknown[]) => unknown;
  (wrapped as { tool: unknown }).tool = (...args: unknown[]) => {
    const handler = args[args.length - 1] as (...a: unknown[]) => Promise<unknown>;
    const counted = async (...a: unknown[]) => {
      if (leaving) {
        return {
          content: [
            {
              type: 'text',
              text:
                'This server is shutting down and did not run that: the client it was ' +
                'started by has gone. Nothing was read or written. Start it again.',
            },
          ],
          isError: true,
        };
      }
      return trackInFlight(() => handler(...a));
    };
    return originalTool(...args.slice(0, -1), counted);
  };

  return wrapped;
}
