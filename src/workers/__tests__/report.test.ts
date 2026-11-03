import { describe, it, expect, afterEach, vi } from 'vitest';

const getBudgets = vi.fn();
const versionCheck = vi.fn();

vi.mock('@actual-app/api', () => ({
  default: {},
  getBudgets: () => getBudgets(),
  utils: {
    amountToInteger: (a: number) => Math.round(a * 100),
    integerToAmount: (c: number) => c / 100,
  },
}));
vi.mock('../../connection.js', () => ({
  serverVersionCheck: () => versionCheck(),
}));

import { reportToPool, tidyCheck } from '../report.js';

const WORKER_FLAG = '--worker';

/** A server that only has to carry one notification. */
function fakeServer(): { sent: unknown[]; server: unknown } {
  const sent: unknown[] = [];
  return {
    sent,
    server: { server: { sendLoggingMessage: async (m: unknown) => void sent.push(m) } },
  };
}

/**
 * What a worker tells its pool (#229).
 *
 * The front end has no budget open and no connection to the Actual server,
 * so the name of a budget and what the two versions said about each other
 * are both things only the worker can know. They go up together, once,
 * after the budget is open.
 */
describe('a worker reporting its budget', () => {
  afterEach(() => {
    const at = process.argv.indexOf(WORKER_FLAG);
    if (at !== -1) process.argv.splice(at, 1);
    delete process.env.ACTUAL_BUDGET_ID;
    getBudgets.mockReset();
    versionCheck.mockReset();
  });

  it('says the name and what the versions said, in one notification', async () => {
    process.argv.push(WORKER_FLAG);
    process.env.ACTUAL_BUDGET_ID = 'sync-one';
    getBudgets.mockResolvedValue([{ id: 'local-1', groupId: 'sync-one', name: 'Household' }]);
    versionCheck.mockReturnValue({
      kind: 'mismatch',
      server: '26.12.0',
      library: '26.11.0',
      serverIs: 'ahead',
    });

    const { sent, server } = fakeServer();
    await reportToPool(server as never);

    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      level: 'info',
      logger: 'actual-budget-mcp/worker',
      data: {
        budgetId: 'sync-one',
        name: 'Household',
        version: { kind: 'mismatch', server: '26.12.0', library: '26.11.0', serverIs: 'ahead' },
      },
    });
  });

  it('says nothing at all in a process nobody started as a worker', async () => {
    process.env.ACTUAL_BUDGET_ID = 'sync-one';
    getBudgets.mockResolvedValue([{ groupId: 'sync-one', name: 'Household' }]);

    const { sent, server } = fakeServer();
    await reportToPool(server as never);

    expect(sent).toEqual([]);
    expect(getBudgets).not.toHaveBeenCalled();
  });

  it('is a kindness, so it fails quietly', async () => {
    process.argv.push(WORKER_FLAG);
    process.env.ACTUAL_BUDGET_ID = 'sync-one';
    getBudgets.mockRejectedValue(new Error('no budget file is open'));

    const { sent, server } = fakeServer();
    await expect(reportToPool(server as never)).resolves.toBeUndefined();
    expect(sent).toEqual([]);
  });

  it('believes only a check it can make sense of', () => {
    expect(tidyCheck({ kind: 'match', server: '26.11.0', library: '26.11.0' })).toEqual({
      kind: 'match',
      server: '26.11.0',
      library: '26.11.0',
    });
    expect(tidyCheck({ kind: 'unreadable', library: '26.11.0' })).toEqual({
      kind: 'unreadable',
      library: '26.11.0',
    });
    expect(tidyCheck({ kind: 'mismatch', server: '26.12.0', library: '26.11.0' })).toBeUndefined();
    expect(tidyCheck({ kind: 'match', library: '26.11.0' })).toBeUndefined();
    expect(tidyCheck({ kind: 'match', server: '26.12.0' })).toBeUndefined();
    expect(tidyCheck('26.11.0')).toBeUndefined();
    expect(tidyCheck(undefined)).toBeUndefined();
    // A version is short, and it lands in a sentence.
    expect(
      tidyCheck({ kind: 'match', server: '9'.repeat(60), library: '26.11.0' }),
    ).toBeUndefined();
    expect(
      tidyCheck({ kind: 'match', server: '26.12.0\nsync-nine', library: '26.11.0' }),
    ).toEqual({ kind: 'match', server: '26.12.0 sync-nine', library: '26.11.0' });
  });
});
