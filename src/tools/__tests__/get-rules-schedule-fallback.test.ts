import { describe, it, expect, vi, beforeEach } from 'vitest';

const getSchedules = vi.fn();
const getRules = vi.fn();
vi.mock('@actual-app/api', () => ({
  getRules: (...a: unknown[]) => getRules(...a),
  getCategories: vi.fn().mockResolvedValue([]),
  getCategoryGroups: vi.fn().mockResolvedValue([]),
  getPayees: vi.fn().mockResolvedValue([]),
  getAccounts: vi.fn().mockResolvedValue([{ id: 'acc-1', name: 'Checking' }]),
  getSchedules: (...a: unknown[]) => getSchedules(...a),
  utils: {
    amountToInteger: (a: number, places = 2) => Math.round(a * Math.pow(10, places)),
    integerToAmount: (c: number, places = 2) => c / Math.pow(10, places),
  },
}));

vi.mock('../../connection.js', () => ({
  ensureConnection: vi.fn().mockResolvedValue(undefined),
}));

import { registerGetRules } from '../read/get-rules.js';

type Handler = () => Promise<{
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}>;

function handler(): Handler {
  let found: Handler | undefined;
  registerGetRules({
    tool: (...a: unknown[]) => {
      found = a.at(-1) as Handler;
    },
  } as never);
  return found as Handler;
}

/**
 * A listing that stays readable when part of it cannot be worked out (#182).
 *
 * Two of those parts. The schedule names are an improvement on one line, not
 * the answer: rethrowing from that catch leaves the whole suite green,
 * because every other test has schedules that can be read. And a recurrence
 * with a pattern nothing can name is printed as the config it is, rather than
 * described from the half that parses or stringified into `[object Object]`.
 *
 * Both are built from rows here instead of through the engine, because
 * neither can be produced by asking Actual for it.
 */
describe('listing rules with a part that cannot be worked out', () => {
  const scheduleRule = {
    id: 'rule-1',
    stage: null,
    conditionsOp: 'and',
    conditions: [{ op: 'is', field: 'account', value: 'acc-1', type: 'id' }],
    actions: [{ op: 'link-schedule', field: null, value: 'sched-1', type: 'id' }],
  };

  beforeEach(() => {
    getSchedules.mockReset();
    getRules.mockReset().mockResolvedValue([scheduleRule]);
  });

  it('still lists the rules, with the id in place of the name', async () => {
    getSchedules.mockRejectedValue(new Error('schedules are not available'));

    const reply = await handler()();
    const text = reply.content[0].text;

    expect(reply.isError, 'losing a name is not an error').toBeFalsy();
    expect(text).toContain('IF account is "Checking"');
    expect(text).toContain('THEN link-schedule = "sched-1"');
  });

  it('prints a recurrence it will not describe as the config it is', async () => {
    // One pattern it cannot name makes the sentence untrue by omission, so
    // the stored config goes out instead. What must not come back is
    // `[object Object]`, which is what this tool was reported for.
    //
    // Built here rather than through the engine on purpose: `schedule/create`
    // computes the first date and throws on this config ("Failed to find a
    // matching occurrence in 50 iterations"), so a schedule like it cannot be
    // made from the app. A rule holding one arrived some other way, which is
    // exactly when a listing has to stay readable.
    getSchedules.mockResolvedValue([]);
    getRules.mockResolvedValue([
      {
        ...scheduleRule,
        conditions: [
          {
            op: 'isapprox',
            field: 'date',
            type: 'date',
            value: {
              start: '2026-11-01',
              frequency: 'monthly',
              patterns: [{ type: 'MO', value: 9 }],
              skipWeekend: false,
              weekendSolveMode: 'after',
              endMode: 'never',
              endOccurrences: 1,
              endDate: '2026-11-01',
            },
          },
        ],
      },
    ]);

    const text = (await handler()()).content[0].text;
    expect(text).not.toContain('[object Object]');
    expect(text).toContain('"frequency":"monthly"');
    expect(text).toContain('"value":9');
  });

  it('names the schedule when they can be read', async () => {
    // The other side of the same line, so the test above cannot pass by the
    // name never being looked up at all.
    getSchedules.mockResolvedValue([{ id: 'sched-1', name: 'Rent' }]);

    const text = (await handler()()).content[0].text;
    expect(text).toContain('THEN link-schedule = "Rent"');
  });
});
