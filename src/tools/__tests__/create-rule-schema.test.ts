import { describe, it, expect, vi } from 'vitest';

vi.mock('@actual-app/api', () => ({
  default: {},
  getPayees: vi.fn().mockResolvedValue([]),
  getCategories: vi.fn().mockResolvedValue([]),
  getCategoryGroups: vi.fn().mockResolvedValue([]),
  getAccounts: vi.fn().mockResolvedValue([]),
  createRule: vi.fn(),
  sync: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../connection.js', () => ({
  ensureConnection: vi.fn().mockResolvedValue(undefined),
}));

import { registerCreateRule } from '../write/create-rule.js';

/**
 * What the tool tells a client it takes (#185).
 *
 * The description is as much the wire as the schema: a client fills these
 * fields from it and never sees the code. Two of the sentences here were
 * added because the engine refuses something the general wording invites, so
 * losing one of them puts callers back on the bare "Failed creating a new
 * rule" this tool exists to replace, with every test still green.
 */
function shapeOf(): Record<string, { description?: string; parse: (v: unknown) => unknown }> {
  let shape: Record<string, never> = {};
  registerCreateRule({
    tool: (...a: unknown[]) => {
      shape = a[2] as never;
    },
  } as never);
  return shape as never;
}

describe('what create_rule says it takes', () => {
  it('names the fields a condition can be answered on, and no others', () => {
    const said = shapeOf().condition_field.description ?? '';
    for (const field of ['cleared', 'reconciled', 'category_group', 'payee_name', 'date']) {
      expect(said, `${field} is missing from the description`).toContain(field);
    }
    // Both are in the engine's table and neither can ever match (#185), so
    // offering them here is inviting a rule that does nothing.
    for (const field of ['transfer', 'parent']) {
      expect(said, `${field} is offered as a condition`).not.toContain(field);
    }
  });

  it('says that a boolean field takes one operator', () => {
    // Without this the list of operators above it reads as if `isNot` worked
    // everywhere, and on cleared it is refused by the engine.
    const said = shapeOf().condition_op.description ?? '';
    expect(said).toContain('cleared and reconciled the only operator is is');
    expect(said).toContain('cleared is false');
  });

  it('says how to write a true or a false', () => {
    const said = shapeOf().condition_value.description ?? '';
    expect(said).toContain('true or false');
    expect(said, 'the spellings it accepts are part of the wire').toContain('yes and 1');
    expect(shapeOf().action_value.description ?? '').toContain('true or false');
  });

  it('takes a value as a boolean or a number, not only as text', () => {
    // A client filling this from JSON writes `true`, not `"true"`. Measured
    // before this: zod answered "Expected string, received boolean", which
    // says nothing about the rule.
    const shape = shapeOf();
    expect(shape.action_value.parse(true)).toBe(true);
    expect(shape.action_value.parse(1)).toBe(1);
    expect(shape.condition_value.parse(false)).toBe(false);
    expect(shape.condition_value.parse(0)).toBe(0);
    expect(shape.condition_value.parse('text')).toBe('text');
    expect(shape.condition_value.parse(['a', 'b'])).toEqual(['a', 'b']);
  });
});
