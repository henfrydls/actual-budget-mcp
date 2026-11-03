import { z } from 'zod';
import type { McpServerLike } from './read-sync.js';
import { budgetProblem, configuredBudgetIds, servesManyBudgets } from './budgets.js';

/**
 * Which budget a call is for, on every tool, in one place (#229).
 *
 * Forty-five call sites would each be a place to forget it, and a place for
 * the parameter to be described slightly differently. So the wrapper adds it
 * to the schema it is handed and takes it off the arguments before the
 * handler runs, and no tool knows it exists.
 *
 * ## Only when there is something to choose
 *
 * With one budget configured the wrapper does nothing at all: no parameter,
 * no description, and what a client is sent is byte for byte what it was
 * sent before any of this. That is the rule the design note fixed on, and
 * it is worth stating as a cost rather than a kindness. The parameter is
 * about a hundred bytes on each of forty-five tools, four kilobytes on
 * every connection, which is the same context argument the chat toolset
 * exists for (#222). Nobody with one budget pays it.
 *
 * ## It refuses before anything else happens
 *
 * The check runs outside the wrappers that sync, count and open things, so
 * a call for a budget this server does not serve costs a sentence rather
 * than a round trip to the Actual server.
 */
const DESCRIPTION =
  'Which budget this is for, by sync id. Defaults to the one the server has open. ' +
  'Ask list_budgets for the ids it serves.';

export function withBudgetId<T extends McpServerLike>(
  server: T,
  many: boolean = servesManyBudgets(),
): T {
  if (!many) return server;

  const wrapped = Object.create(server) as T;
  const originalTool = server.tool.bind(server) as (...args: unknown[]) => unknown;

  (wrapped as { tool: unknown }).tool = (...args: unknown[]) => {
    const [name, description, shape, annotations, handler] = args;
    if (typeof shape !== 'object' || shape === null || typeof handler !== 'function') {
      return originalTool(...args);
    }

    const widened = {
      ...(shape as Record<string, unknown>),
      budget_id: z.string().optional().describe(DESCRIPTION),
    };

    const guarded = async (callArgs: Record<string, unknown>, ...rest: unknown[]) => {
      const { budget_id: asked, ...forTheTool } = callArgs ?? {};
      const problem = budgetProblem(typeof asked === 'string' ? asked : undefined);
      if (problem !== undefined) {
        return { content: [{ type: 'text', text: problem }], isError: true };
      }
      return (handler as (a: unknown, ...r: unknown[]) => unknown)(forTheTool, ...rest);
    };

    return originalTool(name, description, widened, annotations, guarded);
  };

  return wrapped;
}

/** For the listing, which says what this wrapper enforces. */
export { configuredBudgetIds };
