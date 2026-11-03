import { readEnv } from './env.js';

/**
 * Which budgets this server is configured to serve (#229).
 *
 * One, from `ACTUAL_BUDGET_ID`, is what it has always been and what almost
 * every deployment has. `ACTUAL_BUDGET_IDS` names more than one, and it is
 * the whole list: a budget that is not in it cannot be opened by asking for
 * its id, because which budgets a deployment serves is the operator's
 * decision and not the caller's.
 *
 * This is the half of #229 that does not move processes. Serving more than
 * one at a time needs a worker per budget, because `api.loadBudget` is
 * process-global, and that is the next piece. What is here is the question
 * every tool has to answer first: which budget is this call for, and is it
 * one we serve at all.
 */

/** The sync id of the budget this process has open. */
export function openBudgetId(): string | undefined {
  return readEnv('ACTUAL_BUDGET_ID')?.trim();
}

/**
 * Every budget this deployment serves, the open one first.
 *
 * `ACTUAL_BUDGET_IDS` is comma separated, blanks dropped, duplicates
 * dropped, because a list typed by hand collects both.
 */
export function configuredBudgetIds(): string[] {
  const open = openBudgetId();
  const listed = readEnv('ACTUAL_BUDGET_IDS')
    ?.split(',')
    .map((id) => id.trim())
    .filter((id) => id !== '');

  if (listed === undefined || listed.length === 0) return open === undefined ? [] : [open];

  const all = open === undefined ? listed : [open, ...listed];
  return [...new Set(all)];
}

/**
 * Whether anything about this call has to say which budget it is for.
 *
 * With one budget there is nothing to choose, so no tool takes the
 * argument, no schema mentions it, and what a client is sent is what it was
 * sent before any of this (#229). The parameter appears when, and only
 * when, there is a second budget it could name.
 */
export function servesManyBudgets(): boolean {
  return configuredBudgetIds().length > 1;
}

/**
 * What is wrong with the budget a call asked for, if anything.
 *
 * One question now, where there were two: is it one this server serves. The
 * second answer, "we serve it and cannot open it yet", was true while one
 * process could only hold one budget. A worker per budget is what took it
 * away, so what is left is the configuration: a budget that is not on the
 * operator's list cannot be reached by asking for its id.
 */
export function budgetProblem(asked: string | undefined): string | undefined {
  if (asked === undefined) return undefined;

  const wanted = asked.trim();
  if (wanted === '') return undefined;

  const configured = configuredBudgetIds();
  if (configured.includes(wanted)) return undefined;

  return (
    `No budget with id ${wanted} is configured on this server. It serves: ` +
    `${configured.join(', ')}. The id is the sync id, from Settings > Show advanced ` +
    'settings in the Actual app.'
  );
}

/**
 * The configuration that contradicts itself, caught where the rest is.
 *
 * A list that leaves out the budget this server actually opens is a list
 * someone edited one line of. Left alone it reads as "this deployment
 * serves these three", while the one it answers with is a fourth.
 */
export function budgetsProblem(): string | undefined {
  const open = openBudgetId();
  const listed = readEnv('ACTUAL_BUDGET_IDS')
    ?.split(',')
    .map((id) => id.trim())
    .filter((id) => id !== '');

  if (open === undefined || listed === undefined || listed.length === 0) return undefined;
  if (listed.includes(open)) return undefined;

  return (
    `ACTUAL_BUDGET_IDS does not include ACTUAL_BUDGET_ID (${open}), which is the budget ` +
    `this server opens. It lists: ${listed.join(', ')}. Add it, or point ACTUAL_BUDGET_ID ` +
    'at one of them.'
  );
}
