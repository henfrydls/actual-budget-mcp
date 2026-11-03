import { describe, it, expect, afterEach } from 'vitest';
import {
  budgetProblem,
  budgetsProblem,
  configuredBudgetIds,
  openBudgetId,
  servesManyBudgets,
} from '../budgets.js';

const VARS = ['ACTUAL_BUDGET_ID', 'ACTUAL_BUDGET_IDS'];

/**
 * Which budgets a deployment serves, and what to say about one it does not
 * (#229).
 *
 * The list is the operator's. A budget that is not in it cannot be reached
 * by asking for its id, and the three answers below are kept apart because
 * "we do not serve that" and "we serve it and cannot open it yet" send the
 * reader to different places.
 */
describe('the budgets this server serves', () => {
  afterEach(() => {
    for (const name of VARS) delete process.env[name];
  });

  it('is the one it opens, when that is all there is', () => {
    process.env.ACTUAL_BUDGET_ID = 'sync-one';

    expect(configuredBudgetIds()).toEqual(['sync-one']);
    expect(openBudgetId()).toBe('sync-one');
    expect(servesManyBudgets()).toBe(false);
  });

  it('is none of them when nothing is configured', () => {
    expect(configuredBudgetIds()).toEqual([]);
    expect(servesManyBudgets()).toBe(false);
  });

  it('is the list when there is one, with the open budget first', () => {
    process.env.ACTUAL_BUDGET_ID = 'sync-one';
    process.env.ACTUAL_BUDGET_IDS = ' sync-two , sync-one ,, sync-three ';

    // Blanks and the repeat of the open one dropped: a list typed by hand
    // collects both.
    expect(configuredBudgetIds()).toEqual(['sync-one', 'sync-two', 'sync-three']);
    expect(servesManyBudgets()).toBe(true);
  });

  it('says nothing about the budget that is open', () => {
    process.env.ACTUAL_BUDGET_ID = 'sync-one';

    expect(budgetProblem('sync-one')).toBeUndefined();
    expect(budgetProblem(undefined)).toBeUndefined();
    expect(budgetProblem('  ')).toBeUndefined();
  });

  it('says nothing about another budget this server serves', () => {
    // It used to refuse this one, because one process could only hold one
    // budget. A worker per budget is what took that answer away (#229).
    process.env.ACTUAL_BUDGET_ID = 'sync-one';
    process.env.ACTUAL_BUDGET_IDS = 'sync-one,sync-two';

    expect(budgetProblem('sync-two')).toBeUndefined();
  });

  it('tells a caller asking for an id it does not serve which ones it does', () => {
    process.env.ACTUAL_BUDGET_ID = 'sync-one';
    process.env.ACTUAL_BUDGET_IDS = 'sync-one,sync-two';

    const said = budgetProblem('sync-nine');

    expect(said).toContain('sync-nine');
    expect(said).toContain('sync-one');
    expect(said).toContain('sync-two');
    expect(said).toContain('sync id');
  });

  it('catches a list that leaves out the budget this server opens', () => {
    process.env.ACTUAL_BUDGET_ID = 'sync-one';
    process.env.ACTUAL_BUDGET_IDS = 'sync-two,sync-three';

    // Left alone it reads as "this deployment serves these two", while the
    // one it answers with is a third.
    expect(budgetsProblem()).toContain('does not include ACTUAL_BUDGET_ID');
  });

  it('says nothing when the list and the open budget agree, or there is no list', () => {
    process.env.ACTUAL_BUDGET_ID = 'sync-one';
    expect(budgetsProblem()).toBeUndefined();

    process.env.ACTUAL_BUDGET_IDS = 'sync-one,sync-two';
    expect(budgetsProblem()).toBeUndefined();
  });

  it('refuses an id that is a path, when each budget gets a directory', () => {
    // With a worker per budget the id names a directory, so `../x` would
    // put a budget cache next to the data directory rather than inside it.
    process.env.ACTUAL_BUDGET_ID = 'sync-one';
    process.env.ACTUAL_BUDGET_IDS = 'sync-one,../elsewhere';

    const said = budgetsProblem();

    expect(said).toContain('../elsewhere');
    expect(said).toContain('not ids');
  });

  it('leaves an odd id alone when there is only one budget', () => {
    // Nothing names a directory then: the data directory is whatever
    // ACTUAL_DATA_DIR says, and this has always started. A check that
    // stops a server master starts is a worse bug than the one it fixes.
    process.env.ACTUAL_BUDGET_ID = 'My..Budget';

    expect(budgetsProblem()).toBeUndefined();
  });
});
