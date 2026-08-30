import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@actual-app/api', () => ({
  default: {},
  getRules: vi.fn(),
  deleteRule: vi.fn(),
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

    expect(text).toMatch(/condition/i);
    expect(text).toMatch(/action/i);
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
