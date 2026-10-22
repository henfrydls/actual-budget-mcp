import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const getSchedules = vi.fn();
const getAccounts = vi.fn();
const getPayees = vi.fn();
const getTransactions = vi.fn();

vi.mock('@actual-app/api', () => ({
  getSchedules: (...a: unknown[]) => getSchedules(...a),
  getAccounts: (...a: unknown[]) => getAccounts(...a),
  getPayees: (...a: unknown[]) => getPayees(...a),
  getTransactions: (...a: unknown[]) => getTransactions(...a),
  utils: {
    amountToInteger: (a: number, places = 2) => Math.round(a * Math.pow(10, places)),
    integerToAmount: (c: number, places = 2) => c / Math.pow(10, places),
  },
}));

vi.mock('../../connection.js', () => ({
  ensureConnection: vi.fn().mockResolvedValue(undefined),
}));

import { registerGetSchedules } from '../read/get-schedules.js';

type Handler = () => Promise<{
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}>;

function handler(): Handler {
  let found: Handler | undefined;
  registerGetSchedules({
    tool: (...a: unknown[]) => {
      found = a.at(-1) as Handler;
    },
  } as never);
  return found as Handler;
}

async function text(): Promise<string> {
  const result = await handler()();
  return result.content[0].text;
}

/**
 * The shapes here were measured against 26.10 rather than read from the
 * types: a recurring schedule's `date` is an object and a one-off's is a
 * string, and an `isbetween` rule puts the amount in `{num1, num2}` where
 * every other rule puts a number. A listing that assumed one shape printed
 * `[object Object]` for the other.
 */
describe('listing schedules (#150)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(2026, 5, 15));
    getSchedules.mockReset();
    getAccounts.mockReset().mockResolvedValue([
      { id: 'acc-1', name: 'Checking' },
      { id: 'acc-2', name: 'Savings' },
    ]);
    getPayees.mockReset().mockResolvedValue([{ id: 'pay-1', name: 'Landlord' }]);
    getTransactions.mockReset().mockResolvedValue([]);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('says so, and asks the engine nothing else, when there are none', async () => {
    getSchedules.mockResolvedValue([]);

    expect(await text()).toContain('No schedules in this budget');
    expect(getTransactions).not.toHaveBeenCalled();
    expect(getAccounts).not.toHaveBeenCalled();
  });

  it('prints a recurring schedule with its frequency, account and payee', async () => {
    getSchedules.mockResolvedValue([
      {
        id: 'sch-1',
        name: 'Rent',
        next_date: '2026-07-01',
        completed: false,
        posts_transaction: true,
        payee: 'pay-1',
        account: 'acc-1',
        amount: -120000,
        amountOp: 'is',
        date: { start: '2026-01-01', frequency: 'monthly' },
      },
    ]);

    const out = await text();
    expect(out).toContain('=== Schedules (1) ===');
    expect(out).toContain('Rent  next 2026-07-01  -1,200.00  Checking / Landlord');
    // How often it happens comes from the module that measured recurrences
    // for the rules listing, rather than from the stored frequency word.
    expect(out).toContain('every month, from 2026-01-01; posts by itself');
  });

  it('prints a range when the rule is isbetween, not the object', async () => {
    getSchedules.mockResolvedValue([
      {
        id: 'sch-1',
        name: 'Water',
        next_date: '2026-07-15',
        posts_transaction: false,
        payee: null,
        account: 'acc-1',
        amount: { num1: -3000, num2: -5000 },
        amountOp: 'isbetween',
        date: { start: '2026-01-15', frequency: 'monthly' },
      },
    ]);

    const out = await text();
    expect(out).toContain('-30.00 to -50.00');
    expect(out).not.toContain('[object Object]');
    // No payee, so no empty half of the pair.
    expect(out).toContain('-30.00 to -50.00  Checking\n');
    expect(out).toContain('waits to be approved');
  });

  it('calls an approximate amount approximate', async () => {
    getSchedules.mockResolvedValue([
      {
        id: 'sch-1',
        name: 'Power',
        next_date: '2026-07-20',
        account: 'acc-1',
        amount: -4500,
        amountOp: 'isapprox',
        date: { start: '2026-01-20', frequency: 'monthly' },
      },
    ]);

    expect(await text()).toContain('about -45.00');
  });

  it('calls a schedule that happens once "once", because its date is a string', async () => {
    getSchedules.mockResolvedValue([
      {
        id: 'sch-1',
        name: 'One Off',
        next_date: '2026-12-24',
        account: 'acc-1',
        payee: 'pay-1',
        amount: -5000,
        amountOp: 'is',
        date: '2026-12-24',
      },
    ]);

    const out = await text();
    expect(out).toContain('once');
    expect(out).not.toContain('[object Object]');
  });

  it('says a schedule is due when its date has passed, and sorts it first', async () => {
    getSchedules.mockResolvedValue([
      {
        id: 'sch-2',
        name: 'Later',
        next_date: '2026-07-01',
        account: 'acc-1',
        amount: -1000,
        date: { start: '2026-01-01', frequency: 'monthly' },
      },
      {
        id: 'sch-1',
        name: 'Missed',
        next_date: '2026-06-01',
        account: 'acc-1',
        amount: -1000,
        date: { start: '2026-01-01', frequency: 'monthly' },
      },
      {
        id: 'sch-3',
        name: 'Undated',
        account: 'acc-1',
        amount: -1000,
        date: { start: '2026-01-01', frequency: 'monthly' },
      },
    ]);

    const out = await text();
    expect(out.indexOf('Missed')).toBeLessThan(out.indexOf('Later'));
    // A schedule with no next date goes last rather than first.
    expect(out.indexOf('Later')).toBeLessThan(out.indexOf('Undated'));
    // And the names line up, so a long one does not push its row out of true.
    expect(out).toContain('Later    next 2026-07-01');
    expect(out).toContain('due since 2026-06-01');
    expect(out.match(/due since/g)).toHaveLength(1);
  });

  it('calls a finished schedule finished rather than overdue', async () => {
    getSchedules.mockResolvedValue([
      {
        id: 'sch-1',
        name: 'Paid Off',
        next_date: '2026-06-01',
        completed: true,
        account: 'acc-1',
        amount: -1000,
        date: { start: '2026-01-01', frequency: 'monthly' },
      },
    ]);

    const out = await text();
    expect(out).toContain('finished');
    expect(out).not.toContain('due since');
  });

  it('reports the latest transaction the schedule posted, and reads each account once', async () => {
    getSchedules.mockResolvedValue([
      {
        id: 'sch-1',
        name: 'Rent',
        next_date: '2026-07-01',
        account: 'acc-1',
        amount: -1000,
        date: { start: '2026-01-01', frequency: 'monthly' },
      },
      {
        id: 'sch-2',
        name: 'Gym',
        next_date: '2026-07-02',
        account: 'acc-1',
        amount: -1000,
        date: { start: '2026-01-01', frequency: 'monthly' },
      },
    ]);
    getTransactions.mockResolvedValue([
      { date: '2026-04-01', schedule: 'sch-1' },
      { date: '2026-06-01', schedule: 'sch-1' },
      { date: '2026-05-01', schedule: 'sch-1' },
      { date: '2026-05-02', schedule: null },
    ]);

    const out = await text();
    expect(out).toContain('last posted 2026-06-01');
    expect(out).toContain('nothing posted in the last 365 days');
    expect(getTransactions).toHaveBeenCalledTimes(1);
    expect(getTransactions).toHaveBeenCalledWith('acc-1', '2025-06-15', '2026-06-15');
  });

  it('reads every account a schedule points at', async () => {
    getSchedules.mockResolvedValue([
      {
        id: 'sch-1',
        name: 'A',
        next_date: '2026-07-01',
        account: 'acc-1',
        amount: -1000,
      },
      {
        id: 'sch-2',
        name: 'B',
        next_date: '2026-07-02',
        account: 'acc-2',
        amount: -1000,
      },
    ]);

    await text();
    expect(getTransactions).toHaveBeenCalledTimes(2);
    expect(getTransactions.mock.calls.map((c) => c[0]).sort()).toEqual(['acc-1', 'acc-2']);
  });

  it('prints a schedule with nothing filled in rather than failing on it', async () => {
    getSchedules.mockResolvedValue([{ id: 'sch-1' }]);

    const out = await text();
    expect(out).toContain('(unnamed)');
    expect(out).toContain('next (none)');
    expect(out).toContain('(no amount)');
    expect(getTransactions).not.toHaveBeenCalled();
  });

  it('prints a recurrence it cannot read as the config it is', async () => {
    // The rules listing made this call first (#182): a schedule whose
    // pattern means nothing to us is shown raw, because describing it from
    // the half that parses says something untrue about when money moves.
    getSchedules.mockResolvedValue([
      {
        id: 'sch-1',
        name: 'Odd',
        next_date: '2026-07-01',
        account: 'acc-1',
        amount: -1000,
        date: {
          start: '2026-01-01',
          frequency: 'monthly',
          patterns: [{ type: 'day', value: 99 }],
        },
      },
    ]);

    const out = await text();
    expect(out).toContain('{"start":"2026-01-01","frequency":"monthly"');
    expect(out).not.toContain('[object Object]');
  });

  it('reports an engine failure as an error', async () => {
    getSchedules.mockRejectedValue(new Error('no budget loaded'));

    const result = await handler()();
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('no budget loaded');
  });
});
