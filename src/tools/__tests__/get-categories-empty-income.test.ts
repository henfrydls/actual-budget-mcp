import { describe, it, expect, vi, beforeEach } from 'vitest';

const getCategoryGroups = vi.fn();
const getCategories = vi.fn();

vi.mock('@actual-app/api', () => ({
  getCategoryGroups: () => getCategoryGroups(),
  getCategories: () => getCategories(),
  utils: {
    amountToInteger: (a: number, places = 2) => Math.round(a * Math.pow(10, places)),
    integerToAmount: (c: number, places = 2) => c / Math.pow(10, places),
  },
}));
vi.mock('../../connection.js', () => ({
  ensureConnection: vi.fn().mockResolvedValue(undefined),
}));

import { registerGetCategories } from '../read/get-categories.js';

type Tool = (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }>;

function tool(): Tool {
  let handler: Tool | undefined;
  registerGetCategories({
    tool: (...a: unknown[]) => {
      handler = a.at(-1) as Tool;
    },
  } as never);
  return handler as Tool;
}

/**
 * The income group, which this reply builds from its categories (#283).
 *
 * Every other group is listed by walking the group list, so an empty one is
 * marked there. Income is gathered from the categories instead, wherever
 * they live, so an income group with nothing in it produced no line at all
 * and its id could not be read back either.
 *
 * Built from rows rather than from the engine because a budget the engine
 * makes comes with income categories in it, and the case is a budget with
 * none.
 */
describe('an income group with no categories', () => {
  beforeEach(() => {
    getCategories.mockReset().mockResolvedValue([]);
    getCategoryGroups.mockReset();
  });

  it('is listed with its id and the mark', async () => {
    getCategoryGroups.mockResolvedValue([{ id: 'grp-income', name: 'Income', is_income: true }]);

    const text = (await tool()({})).content[0].text;

    expect(text).toContain('Income (grp-income)  [empty]');
  });

  it('is not marked when something income lives somewhere else', async () => {
    // A category flagged income inside a spending group is listed under the
    // income heading, so the group that heading names is not empty as far
    // as this reply is concerned.
    getCategoryGroups.mockResolvedValue([
      { id: 'grp-income', name: 'Income', is_income: true },
      { id: 'grp-everyday', name: 'Everyday' },
    ]);
    getCategories.mockResolvedValue([
      { id: 'cat-1', name: 'Salary', group_id: 'grp-everyday', is_income: true },
    ]);

    const text = (await tool()({})).content[0].text;

    expect(text).toContain('Income (grp-income)');
    expect(text).not.toContain('Income (grp-income)  [empty]');
    expect(text).toContain('Salary');
  });
});
