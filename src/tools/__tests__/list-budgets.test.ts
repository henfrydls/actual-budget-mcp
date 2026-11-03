import { describe, it, expect, afterEach, vi } from 'vitest';

const getBudgets = vi.fn();

vi.mock('@actual-app/api', () => ({
  getBudgets: () => getBudgets(),
  utils: {
    amountToInteger: (a: number, places = 2) => Math.round(a * Math.pow(10, places)),
    integerToAmount: (c: number, places = 2) => c / Math.pow(10, places),
  },
}));
vi.mock('../../connection.js', () => ({
  ensureConnection: vi.fn().mockResolvedValue(undefined),
}));

import { registerListBudgets } from '../read/list-budgets.js';

const VARS = ['ACTUAL_BUDGET_ID', 'ACTUAL_BUDGET_IDS'];

type Handler = () => Promise<{ content: Array<{ text: string }>; isError?: boolean }>;

function handler(): Handler {
  let found: Handler | undefined;
  registerListBudgets({
    tool: (...a: unknown[]) => {
      found = a.at(-1) as Handler;
    },
  } as never);
  return found as Handler;
}

/**
 * The ids a caller has to pass, which were nowhere (#229).
 *
 * The one `ACTUAL_BUDGET_ID` holds is the sync id, which the engine returns
 * as `groupId`; the local folder has an id of its own that means nothing to
 * anyone else. Without this tool the only way to know either was to have
 * configured the server.
 */
describe('listing the budgets this server serves', () => {
  afterEach(() => {
    for (const name of VARS) delete process.env[name];
    getBudgets.mockReset();
  });

  it('lists the configured ones by sync id, and marks the open one', async () => {
    process.env.ACTUAL_BUDGET_ID = 'sync-one';
    process.env.ACTUAL_BUDGET_IDS = 'sync-one,sync-two';
    getBudgets.mockResolvedValue([
      { id: 'local-1', name: 'Household', groupId: 'sync-one' },
      { id: 'local-2', name: 'Business', groupId: 'sync-two' },
    ]);

    const text = (await handler()()).content[0].text;

    expect(text).toContain('=== Budgets (2) ===');
    expect(text).toContain('Household (sync-one)  [open]');
    expect(text).toContain('Business (sync-two)');
    expect(text).not.toContain('Business (sync-two)  [open]');
  });

  it('says so when a budget has never been downloaded here', async () => {
    process.env.ACTUAL_BUDGET_ID = 'sync-one';
    process.env.ACTUAL_BUDGET_IDS = 'sync-one,sync-three';
    getBudgets.mockResolvedValue([{ id: 'local-1', name: 'Household', groupId: 'sync-one' }]);

    const text = (await handler()()).content[0].text;

    // The name lives in the file and the file is not here. Inventing one
    // would be worse than saying the id alone.
    expect(text).toContain('(not downloaded here) (sync-three)');
  });

  it('lists none of the budgets on the server that nobody configured', async () => {
    process.env.ACTUAL_BUDGET_ID = 'sync-one';
    getBudgets.mockResolvedValue([
      { id: 'local-1', name: 'Household', groupId: 'sync-one' },
      { id: 'local-9', name: 'Someone Else', groupId: 'sync-nine' },
    ]);

    const text = (await handler()()).content[0].text;

    expect(text).toContain('Household (sync-one)');
    expect(text).not.toContain('Someone Else');
    expect(text).not.toContain('sync-nine');
  });

  it('says how to serve more than one when it serves one', async () => {
    process.env.ACTUAL_BUDGET_ID = 'sync-one';
    getBudgets.mockResolvedValue([{ id: 'local-1', name: 'Household', groupId: 'sync-one' }]);

    expect((await handler()()).content[0].text).toContain('ACTUAL_BUDGET_IDS');
  });

  it('finds a budget by the cloud id as well, since both are in use', async () => {
    process.env.ACTUAL_BUDGET_ID = 'cloud-1';
    getBudgets.mockResolvedValue([
      { id: 'local-1', name: 'Household', groupId: 'sync-one', cloudFileId: 'cloud-1' },
    ]);

    expect((await handler()()).content[0].text).toContain('Household (cloud-1)');
  });

  it('reports a failure as an error rather than an empty list', async () => {
    process.env.ACTUAL_BUDGET_ID = 'sync-one';
    getBudgets.mockRejectedValue(new Error('no server'));

    const reply = await handler()();

    expect(reply.isError).toBe(true);
    expect(reply.content[0].text).toContain('no server');
  });
});
