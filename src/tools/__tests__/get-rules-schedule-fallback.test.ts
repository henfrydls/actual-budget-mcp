import { describe, it, expect, vi, beforeEach } from 'vitest';

const getSchedules = vi.fn();
vi.mock('@actual-app/api', () => ({
  getRules: vi.fn().mockResolvedValue([
    {
      id: 'rule-1',
      stage: null,
      conditionsOp: 'and',
      conditions: [{ op: 'is', field: 'account', value: 'acc-1', type: 'id' }],
      actions: [{ op: 'link-schedule', field: null, value: 'sched-1', type: 'id' }],
    },
  ]),
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
 * The schedule names are an improvement on one line, not the answer (#182).
 *
 * `get_rules` exists to let someone read their rules. Looking up the name of
 * the schedule a rule links to is worth doing and worth losing: rethrowing
 * from that catch leaves the whole suite green, because every other test has
 * schedules that can be read.
 */
describe('listing rules when the schedules cannot be read', () => {
  beforeEach(() => {
    getSchedules.mockReset();
  });

  it('still lists the rules, with the id in place of the name', async () => {
    getSchedules.mockRejectedValue(new Error('schedules are not available'));

    const reply = await handler()();
    const text = reply.content[0].text;

    expect(reply.isError, 'losing a name is not an error').toBeFalsy();
    expect(text).toContain('IF account is "Checking"');
    expect(text).toContain('THEN link-schedule = "sched-1"');
  });

  it('names the schedule when they can be read', async () => {
    // The other side of the same line, so the test above cannot pass by the
    // name never being looked up at all.
    getSchedules.mockResolvedValue([{ id: 'sched-1', name: 'Rent' }]);

    const text = (await handler()()).content[0].text;
    expect(text).toContain('THEN link-schedule = "Rent"');
  });
});
