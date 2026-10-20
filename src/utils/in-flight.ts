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

/** For tests: forget everything, as if the process had just started. */
export function resetInFlight(): void {
  active = 0;
  waiting = [];
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
    const counted = (...a: unknown[]) => trackInFlight(() => handler(...a));
    return originalTool(...args.slice(0, -1), counted);
  };

  return wrapped;
}
