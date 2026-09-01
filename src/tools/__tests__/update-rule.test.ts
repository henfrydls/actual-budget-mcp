import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@actual-app/api', () => ({
  default: {},
  getRules: vi.fn(),
  updateRule: vi.fn(),
  getCategories: vi.fn(),
  sync: vi.fn().mockResolvedValue(undefined),
  utils: {
    amountToInteger: (a: number) => Math.round(a * 100),
    integerToAmount: (c: number) => c / 100,
  },
}));

vi.mock('../../connection.js', () => ({
  ensureConnection: vi.fn().mockResolvedValue(undefined),
}));

import * as api from '@actual-app/api';
import { updateRuleFields } from '../write/update-rule.js';

const existingRule = {
  id: 'r1',
  stage: null,
  conditionsOp: 'and',
  conditions: [{ field: 'payee', op: 'is', value: 'Supermarket' }],
  actions: [{ op: 'set', field: 'category', value: 'cat-old' }],
};

describe('updateRuleFields', () => {
  beforeEach(() => {
    vi.mocked(api.getRules).mockReset().mockResolvedValue([existingRule] as never);
    vi.mocked(api.updateRule).mockReset().mockResolvedValue({ id: 'r1' } as never);
    vi.mocked(api.getCategories).mockReset().mockResolvedValue([
      { id: 'cat-new', name: 'Groceries', group_id: 'g1' },
    ] as never);
  });

  it('changes only what was asked, keeping the rest of the rule', async () => {
    await updateRuleFields({ rule_id: 'r1', condition_value: 'Corner Shop' });

    const sent = vi.mocked(api.updateRule).mock.calls[0][0] as typeof existingRule;
    expect(sent.conditions[0].value).toBe('Corner Shop');
    // The parts nobody touched must survive — the #44 lesson.
    expect(sent.conditions[0].field).toBe('payee');
    expect(sent.conditions[0].op).toBe('is');
    expect(sent.actions[0].value).toBe('cat-old');
  });

  it('sends the whole rule, not a partial patch', async () => {
    await updateRuleFields({ rule_id: 'r1', action_value: 'Groceries' });

    const sent = vi.mocked(api.updateRule).mock.calls[0][0] as typeof existingRule;
    expect(sent.id).toBe('r1');
    expect(sent.conditions).toHaveLength(1);
    expect(sent.actions).toHaveLength(1);
  });

  it('resolves a category name to its id in the action', async () => {
    await updateRuleFields({ rule_id: 'r1', action_field: 'category', action_value: 'Groceries' });

    const sent = vi.mocked(api.updateRule).mock.calls[0][0] as typeof existingRule;
    expect(sent.actions[0].value).toBe('cat-new');
  });

  it('updates the condition operator on its own', async () => {
    await updateRuleFields({ rule_id: 'r1', condition_op: 'contains' });

    const sent = vi.mocked(api.updateRule).mock.calls[0][0] as typeof existingRule;
    expect(sent.conditions[0].op).toBe('contains');
    expect(sent.conditions[0].value).toBe('Supermarket');
  });

  it('sets the stage', async () => {
    await updateRuleFields({ rule_id: 'r1', stage: 'pre' });

    const sent = vi.mocked(api.updateRule).mock.calls[0][0] as { stage: string | null };
    expect(sent.stage).toBe('pre');
  });

  it('treats the string "null" as clearing the stage', async () => {
    await updateRuleFields({ rule_id: 'r1', stage: 'null' });

    const sent = vi.mocked(api.updateRule).mock.calls[0][0] as { stage: string | null };
    expect(sent.stage).toBeNull();
  });

  it('refuses when no field was given, instead of a silent no-op', async () => {
    await expect(updateRuleFields({ rule_id: 'r1' })).rejects.toThrow(/no fields/i);
    expect(api.updateRule).not.toHaveBeenCalled();
  });

  it('reports a rule that does not exist', async () => {
    vi.mocked(api.getRules).mockResolvedValue([] as never);

    await expect(updateRuleFields({ rule_id: 'nope', stage: 'pre' })).rejects.toThrow(/not found/i);
    expect(api.updateRule).not.toHaveBeenCalled();
  });

  it('reports what changed', async () => {
    const lines = await updateRuleFields({ rule_id: 'r1', condition_value: 'Corner Shop' });

    expect(lines.join('\n')).toContain('Corner Shop');
  });
});
