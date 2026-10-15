import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@actual-app/api', () => ({
  default: {},
  getRules: vi.fn(),
  deleteRule: vi.fn(),
  sync: vi.fn().mockResolvedValue(undefined),
  // The preview names what the rule points at, so the lookups are part of
  // what this tool does now and not incidental mocking (#186).
  getCategories: vi.fn().mockResolvedValue([{ id: 'c1', name: 'Fun', group_id: 'g1' }]),
  getCategoryGroups: vi.fn().mockResolvedValue([{ id: 'g1', name: 'Spending' }]),
  getPayees: vi.fn().mockResolvedValue([{ id: 'p1', name: 'Cinema' }]),
  getAccounts: vi.fn().mockResolvedValue([{ id: 'a1', name: 'Checking' }]),
  getSchedules: vi.fn().mockResolvedValue([]),
  utils: {
    amountToInteger: (a: number) => Math.round(a * 100),
    integerToAmount: (c: number) => c / 100,
  },
}));

vi.mock('../../connection.js', () => ({
  ensureConnection: vi.fn().mockResolvedValue(undefined),
}));

import * as api from '@actual-app/api';
import { deleteRuleGuarded } from '../write/delete-rule.js';

describe('deleteRuleGuarded', () => {
  beforeEach(() => {
    vi.mocked(api.getRules).mockReset().mockResolvedValue([
      {
        id: 'r1',
        stage: 'default',
        conditions: [{ field: 'payee', op: 'is', value: 'p1' }],
        actions: [{ field: 'category', op: 'set', value: 'c1' }],
      },
    ] as never);
    vi.mocked(api.deleteRule).mockReset().mockResolvedValue(true as never);
  });

  it('previews on the first call and deletes nothing', async () => {
    const result = await deleteRuleGuarded({ rule_id: 'r1' });

    expect(result.deleted).toBe(false);
    expect(api.deleteRule).not.toHaveBeenCalled();
  });

  it('describes the rule, which is unreadable from its id alone', async () => {
    const result = await deleteRuleGuarded({ rule_id: 'r1' });
    const text = result.lines.join('\n');

    // What the rule does, in the words `get_rules` uses. This used to count
    // the conditions and the actions under their own headings and then print
    // each one through `JSON.stringify`, so the headings were the only part
    // of the preview anyone could read; the lines they counted are listed
    // here, which is the thing worth knowing.
    expect(text).toContain('Stage: default | Conditions: and');
    expect(text).toMatch(/^ *IF /m);
    expect(text).toMatch(/^ *THEN /m);
  });

  it('names what the rule points at, instead of printing its ids', async () => {
    // The ids are what the rule stores and what this used to print, so the
    // confirmation showed `payee is "p1"` and `category set "c1"`: the one
    // thing it exists for, recognising the rule, was the unreadable part.
    const result = await deleteRuleGuarded({ rule_id: 'r1' });
    const text = result.lines.join('\n');

    expect(text).toContain('IF payee is "Cinema"');
    expect(text).toContain('THEN set category = "Fun"');
    expect(text, 'the ids are what nobody can read').not.toMatch(/"p1"|"c1"/);
  });

  it('says what is wrong with the rule it is about to delete', async () => {
    // The warnings travel with the lines, and this is the moment they are
    // worth most: a rule that takes every import down with it is one to
    // delete, and the preview is where that decision is made.
    vi.mocked(api.getRules).mockResolvedValue([
      {
        id: 'r2',
        stage: 'default',
        conditions: [{ field: 'notes', op: 'is', value: 'poison' }],
        actions: [{ field: 'transfer', op: 'set', value: true }],
      },
    ] as never);

    const result = await deleteRuleGuarded({ rule_id: 'r2' });

    expect(result.lines.join('\n')).toContain('Actual keeps no transfer column');
  });

  it('deletes when confirmed', async () => {
    const result = await deleteRuleGuarded({ rule_id: 'r1', confirm: true });

    expect(result.deleted).toBe(true);
    expect(api.deleteRule).toHaveBeenCalledWith('r1');
  });

  it('reports a missing rule without claiming a deletion', async () => {
    vi.mocked(api.getRules).mockResolvedValue([] as never);

    const result = await deleteRuleGuarded({ rule_id: 'nope' });

    expect(result.deleted).toBe(false);
    expect(result.lines.join('\n')).toMatch(/not found/i);
    expect(api.deleteRule).not.toHaveBeenCalled();
  });
});
