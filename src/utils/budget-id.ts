import { z } from 'zod';
import type { McpServerLike } from './read-sync.js';
import { budgetProblem, configuredBudgetIds, openBudgetId, servesManyBudgets } from './budgets.js';
import { poolInUse } from '../workers/current.js';

/**
 * Which budget a call is for, on every tool, in one place (#229).
 *
 * Forty-five call sites would each be a place to forget it, and a place for
 * the parameter to be described slightly differently. So the wrapper adds it
 * to the schema it is handed, takes it off the arguments, and sends the call
 * to the worker that holds that budget. No tool knows any of it happened.
 *
 * ## Only when there is something to choose
 *
 * With one budget configured the wrapper does nothing at all: no parameter,
 * no description, no child process, and what a client is sent is byte for
 * byte what it was sent before any of this. The tool runs here, as it always
 * did.
 *
 * It is worth stating as a cost rather than a kindness. Measured with two
 * budgets configured, the parameter and the listing tool are 7.9 KiB on top
 * of 39.7, a fifth again of every connection, which is the same context
 * argument the chat toolset exists for (#222). Nobody with one budget pays
 * it.
 *
 * ## Everything is routed, or nothing is
 *
 * With a pool, the front end opens no budget at all, not even the default
 * one: it holds no data directory, takes no lock and keeps no session, which
 * is what lets it answer `tools/list` without starting anything. So a call
 * either reaches a worker or is refused here, and there is no third path
 * where the front half-answers from a budget of its own.
 */
const DESCRIPTION =
  'Which budget this is for, by sync id. Defaults to the one in ACTUAL_BUDGET_ID. ' +
  'Ask list_budgets for the ids this server serves.';

/**
 * What the front end answers itself, rather than routing.
 *
 * `list_budgets` is about this server and not about a budget: it has no
 * budget to take an id for, and no worker to ask either, because a worker
 * holds one budget and does not know the others exist. Measured against two
 * real budgets over HTTP: routed like every other tool, it reached a worker
 * and came back `Tool list_budgets not found`, while `tools/list` had just
 * offered it.
 */
const ANSWERED_HERE = new Set(['list_budgets']);

export function withBudgetId<T extends McpServerLike>(
  server: T,
  many: boolean = servesManyBudgets(),
): T {
  if (!many) return server;

  const wrapped = Object.create(server) as T;
  const originalTool = server.tool.bind(server) as (...args: unknown[]) => unknown;

  (wrapped as { tool: unknown }).tool = (...args: unknown[]) => {
    const [name, description, shape, annotations, handler] = args;
    if (typeof name !== 'string' || typeof shape !== 'object' || shape === null) {
      return originalTool(...args);
    }
    if (ANSWERED_HERE.has(name)) return originalTool(...args);

    const widened = {
      ...(shape as Record<string, unknown>),
      budget_id: z.string().optional().describe(DESCRIPTION),
    };

    const readOnly =
      typeof annotations === 'object' &&
      annotations !== null &&
      (annotations as { readOnlyHint?: unknown }).readOnlyHint === true;

    const routed = async (callArgs: Record<string, unknown>, ...rest: unknown[]) => {
      const { budget_id: asked, ...forTheTool } = callArgs ?? {};
      const wanted = typeof asked === 'string' ? asked.trim() : '';

      const problem = budgetProblem(wanted === '' ? undefined : wanted);
      if (problem !== undefined) {
        return { content: [{ type: 'text', text: problem }], isError: true };
      }

      const pool = poolInUse();
      if (pool === undefined) {
        // No pool and more than one budget configured is a server that was
        // not finished starting. Saying so beats answering from whichever
        // budget this process happens to hold.
        return {
          content: [
            {
              type: 'text',
              text:
                'This server is configured for more than one budget and has no workers to ' +
                'reach them with. Nothing was read or written. Restart it, and if this ' +
                'keeps happening, configure one budget in ACTUAL_BUDGET_ID.',
            },
          ],
          isError: true,
        };
      }

      const target = wanted === '' ? (openBudgetId() ?? configuredBudgetIds()[0]) : wanted;
      void handler;
      void rest;
      return pool.call(target as string, {
        name,
        arguments: forTheTool as Record<string, unknown>,
        readOnly,
      });
    };

    return originalTool(name, description, widened, annotations, routed);
  };

  return wrapped;
}

export { configuredBudgetIds };
