import { describe, it, expect, afterEach, vi } from 'vitest';

const getBudgets = vi.fn();

vi.mock('@actual-app/api', () => ({
  getBudgets: () => getBudgets(),
  utils: {
    amountToInteger: (a: number, places = 2) => Math.round(a * Math.pow(10, places)),
    integerToAmount: (c: number, places = 2) => c / Math.pow(10, places),
  },
}));
const versionCheck = vi.fn();
vi.mock('../../connection.js', () => ({
  ensureConnection: vi.fn().mockResolvedValue(undefined),
  serverVersionCheck: () => versionCheck(),
}));

import { registerListBudgets } from '../read/list-budgets.js';
import { usePool } from '../../workers/current.js';

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
    usePool(undefined);
    versionCheck.mockReset();
  });

  it('carries the version mismatch to whoever asked, in one line', async () => {
    // A server a client starts in the background says this on stderr and
    // nobody is there to read it. This is the reply somebody did ask for.
    process.env.ACTUAL_BUDGET_ID = 'sync-one';
    getBudgets.mockResolvedValue([{ groupId: 'sync-one', name: 'Household' }]);
    versionCheck.mockReturnValue({
      kind: 'mismatch',
      server: '26.12.0',
      library: '26.11.0',
      serverIs: 'ahead',
    });

    const text = (await handler()()).content[0].text;

    expect(text).toContain('26.12.0');
    expect(text).toContain('26.11.0');
  });

  it('says nothing about versions when they agree', async () => {
    process.env.ACTUAL_BUDGET_ID = 'sync-one';
    getBudgets.mockResolvedValue([{ groupId: 'sync-one', name: 'Household' }]);
    versionCheck.mockReturnValue({ kind: 'match', server: '26.11.0', library: '26.11.0' });

    expect((await handler()()).content[0].text).not.toContain('26.11.0');
  });

  /** A pool that knows what its workers have told it. */
  function fakePool(
    open: string[],
    known: Record<string, { name?: string; version?: unknown }> = {},
  ): void {
    usePool({
      openBudgets: () => open,
      knownBudgets: () =>
        new Map(Object.entries(known).map(([id, report]) => [id, { budgetId: id, ...report }])),
    } as never);
  }

  it('says which of them are open, and opens none of them to say it', async () => {
    // With workers the front end holds no budget, so there is no
    // `getBudgets` to ask here: what it knows about a budget is what the
    // worker holding it said (#229).
    process.env.ACTUAL_BUDGET_ID = 'sync-one';
    process.env.ACTUAL_BUDGET_IDS = 'sync-one,sync-two,sync-three';
    fakePool(['sync-one', 'sync-three']);

    const text = (await handler()()).content[0].text;

    expect(text).toContain('=== Budgets (3) ===');
    expect(text).toContain('sync-one  [open]');
    expect(text).toContain('sync-three  [open]');
    expect(text).toContain('sync-two  (not opened yet)');
    expect(getBudgets).not.toHaveBeenCalled();
  });

  it('names the budgets a worker has opened, and keeps the name after it closed', async () => {
    // A worker is closed after fifteen idle minutes. If the name went with
    // it, this would say "not opened yet" about a budget it opened twice
    // this morning, which is the state most of the day.
    process.env.ACTUAL_BUDGET_ID = 'sync-one';
    process.env.ACTUAL_BUDGET_IDS = 'sync-one,sync-two,sync-three';
    fakePool(['sync-one'], {
      'sync-one': { name: 'Household' },
      'sync-two': { name: 'Business' },
    });

    const text = (await handler()()).content[0].text;

    expect(text).toContain('Household (sync-one)  [open]');
    expect(text).toContain('Business (sync-two)  (closed)');
    expect(text).toContain('sync-three  (not opened yet)');
  });

  it('lists the configured ones by sync id, without opening any of them', async () => {
    // With more than one budget this process holds none of them, so there
    // is no `getBudgets` to ask and no name to show: the name lives inside
    // the budget file, which is in a worker's data directory. Asking the
    // engine here is how the front end would end up holding a budget.
    process.env.ACTUAL_BUDGET_ID = 'sync-one';
    process.env.ACTUAL_BUDGET_IDS = 'sync-one,sync-two';

    const text = (await handler()()).content[0].text;

    expect(text).toContain('=== Budgets (2) ===');
    expect(text).toContain('sync-one  (not opened yet)');
    expect(text).toContain('sync-two  (not opened yet)');
    expect(getBudgets).not.toHaveBeenCalled();
  });

  it('says a budget is open when a worker has it, and not otherwise', async () => {
    process.env.ACTUAL_BUDGET_ID = 'sync-one';
    process.env.ACTUAL_BUDGET_IDS = 'sync-one,sync-three';
    fakePool(['sync-three']);

    const text = (await handler()()).content[0].text;

    expect(text).toContain('sync-three  [open]');
    expect(text).toContain('sync-one  (not opened yet)');
  });

  it('says which budget the versions disagree about, and why, once', async () => {
    // The front end has no connection to the Actual server, so it cannot
    // work this out: it is what the worker that opened the budget said
    // when it opened it. The line goes beside that budget; the sentence
    // that explains it goes once.
    process.env.ACTUAL_BUDGET_ID = 'sync-one';
    process.env.ACTUAL_BUDGET_IDS = 'sync-one,sync-two';
    fakePool(['sync-one', 'sync-two'], {
      'sync-one': {
        name: 'Household',
        version: { kind: 'mismatch', server: '26.12.0', library: '26.11.0', serverIs: 'ahead' },
      },
      'sync-two': {
        name: 'Business',
        version: { kind: 'match', server: '26.11.0', library: '26.11.0' },
      },
    });

    const text = (await handler()()).content[0].text;

    expect(text).toContain('Household (sync-one)  [open]  Actual 26.12.0, library 26.11.0');
    expect(text).toContain('Business (sync-two)  [open]');
    expect(text).not.toContain('Business (sync-two)  [open]  Actual');
    // And the sentence, once, at the end: the line says which budget and
    // the sentence says what it means.
    expect(text).toContain('migrations this library does not have');
    expect(text.match(/26\.12\.0/g)).toHaveLength(2);
  });

  it('says nothing about versions when every worker found them matching', async () => {
    process.env.ACTUAL_BUDGET_ID = 'sync-one';
    process.env.ACTUAL_BUDGET_IDS = 'sync-one,sync-two';
    fakePool(['sync-one'], {
      'sync-one': {
        name: 'Household',
        version: { kind: 'match', server: '26.11.0', library: '26.11.0' },
      },
    });

    expect((await handler()()).content[0].text).not.toContain('26.11.0');
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
