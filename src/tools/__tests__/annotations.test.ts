import { describe, it, expect, vi } from 'vitest';

vi.mock('@actual-app/api', () => ({
  default: {},
  utils: {
    amountToInteger: (a: number) => Math.round(a * 100),
    integerToAmount: (c: number) => c / 100,
  },
}));

vi.mock('../../connection.js', () => ({
  ensureConnection: vi.fn().mockResolvedValue(undefined),
  getInternal: vi.fn(),
}));

import { registerAllTools } from '../index.js';

interface Annotations {
  title?: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
}

/** Every tool, with the annotations it registers. */
function registered(): Array<{ name: string; annotations: Annotations }> {
  const out: Array<{ name: string; annotations: Annotations }> = [];
  registerAllTools({
    tool: (name: string, _d: unknown, _s: unknown, annotations: Annotations) => {
      out.push({ name, annotations: annotations ?? {} });
    },
  } as never);
  return out;
}

/** The six tools that destroy something Actual cannot bring back. */
const DESTRUCTIVE = [
  'delete_account',
  'delete_category',
  'delete_category_group',
  'delete_payee',
  'delete_rule',
  'delete_transaction',
];

/**
 * Tool annotations are how a client decides what to show, what to warn about,
 * and what to withhold from a model. They are also a review requirement for
 * Desktop Extensions, where a missing read/write split is grounds for rejection.
 *
 * Neither reason is why this test exists. It exists because an annotation is
 * metadata: nothing fails when it is wrong, so a tool added next year can claim
 * to be read-only while deleting things, and no user-visible behaviour would
 * change until someone trusted the claim.
 */
describe('tool annotations', () => {
  it('gives every tool a human-readable title', () => {
    const missing = registered().filter((t) => !t.annotations.title?.trim());

    expect(missing.map((t) => t.name)).toEqual([]);
  });

  it('never uses the identifier as the title', () => {
    // "create_transaction" as a title is the same as no title: it tells a
    // person nothing the name did not already say.
    const lazy = registered().filter((t) => t.annotations.title === t.name);

    expect(lazy.map((t) => t.name)).toEqual([]);
  });

  it('marks every tool as read-only or not, never leaving it unsaid', () => {
    const unstated = registered().filter((t) => typeof t.annotations.readOnlyHint !== 'boolean');

    expect(unstated.map((t) => t.name)).toEqual([]);
  });

  it('marks the six irreversible deletes as destructive', () => {
    const all = registered();
    const flagged = all.filter((t) => t.annotations.destructiveHint === true).map((t) => t.name);

    expect(flagged.sort()).toEqual([...DESTRUCTIVE].sort());
  });

  it('never claims a destructive tool is read-only', () => {
    const contradictory = registered().filter(
      (t) => t.annotations.destructiveHint === true && t.annotations.readOnlyHint === true,
    );

    expect(contradictory.map((t) => t.name)).toEqual([]);
  });

  it('exposes only read-only tools in read-only mode', () => {
    process.env.ACTUAL_READ_ONLY = '1';
    try {
      const writers = registered().filter((t) => t.annotations.readOnlyHint === false);

      // repair_sync is the deliberate exception: it repairs sync state rather
      // than budget data, and hiding it would leave a desynced budget with no
      // way out (#41). Everything else exposed here must be a genuine read.
      expect(writers.map((t) => t.name)).toEqual(['repair_sync']);
    } finally {
      delete process.env.ACTUAL_READ_ONLY;
    }
  });
});
