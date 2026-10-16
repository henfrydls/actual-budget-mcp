import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

vi.mock('@actual-app/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@actual-app/api')>();
  return { ...actual, sync: vi.fn().mockResolvedValue(undefined) };
});
vi.mock('../../../connection.js', () => ({
  ensureConnection: vi.fn().mockResolvedValue(undefined),
}));

import { initTestEngine, shutdownTestEngine, createFreshBudget, api } from './actual-engine.js';
import { registerGetRules } from '../../read/get-rules.js';

const skip = process.env.SKIP_ACTUAL_INTEGRATION === '1';

/**
 * What a rule's values look like in the listing, against values the engine
 * really stores (#186).
 *
 * The quotes carry the one distinction that matters here: text the budget is
 * holding, as against a figure, a true or false, or the name an id stands
 * for. Each pair below is a working rule beside a broken one that used to
 * print the same line.
 */
describe.skipIf(skip)('what a rule value looks like in the listing', () => {
  let text = '';

  beforeAll(async () => {
    await initTestEngine();
    let payeeId = '';
    await createFreshBudget(async () => {
      await api.createAccount({ name: 'Checking', offbudget: false } as never, 0);
      payeeId = (await api.createPayee({ name: 'Netflix' } as never)) as string;
    }, 'rule-listing-values');

    const rule = async (conditions: unknown[], actions: unknown[]) =>
      api.createRule({ stage: null, conditionsOp: 'and', conditions, actions } as never);

    // The pair the issue names: nothing, and the empty text. On `amount` the
    // first sets every matching transaction to zero and the second takes the
    // next import down, and both printed `(none)`.
    await rule([{ op: 'is', field: 'notes', value: 'a' }], [{ op: 'set', field: 'amount', value: null }]);
    await rule([{ op: 'is', field: 'notes', value: 'b' }], [{ op: 'set', field: 'amount', value: '' }]);
    // The payee that is a payee, and the payee that is the text of one.
    await rule([{ op: 'is', field: 'payee', value: payeeId }], [{ op: 'set', field: 'notes', value: 'x' }]);
    await rule([{ op: 'is', field: 'payee', value: 'Netflix' }], [{ op: 'set', field: 'notes', value: 'y' }]);
    // A value written somewhere else, which the engine reads instead of the
    // stored one.
    await rule(
      [{ op: 'is', field: 'notes', value: 'c' }],
      [{ op: 'set', field: 'amount', value: '', options: { template: '{{ 5 }}' } }],
    );
    // A split action, which carries no field and whose value means three
    // different things.
    await rule(
      [{ op: 'is', field: 'notes', value: 'd' }],
      [
        { op: 'set-split-amount', value: 50, options: { splitIndex: 1, method: 'fixed-percent' } },
        { op: 'set-split-amount', value: 0, options: { splitIndex: 2, method: 'remainder' } },
        { op: 'set-split-amount', value: 2500, options: { splitIndex: 3, method: 'fixed-amount' } },
      ],
    );
    // A note holding a quote, which could be read as two values.
    await rule([{ op: 'is', field: 'notes', value: 'a", "b' }], [{ op: 'set', field: 'notes', value: 'z' }]);

    let handler: (() => Promise<{ content: { text: string }[] }>) | undefined;
    registerGetRules({
      tool: (...a: unknown[]) => {
        handler = a.at(-1) as never;
      },
    } as never);
    text = (await handler!()).content[0].text;
  }, 60_000);

  afterAll(async () => {
    await shutdownTestEngine();
  });

  it('tells nothing apart from the empty text', () => {
    expect(text).toContain('THEN set amount = (none)');
    expect(text).toContain('THEN set amount = ""');
  });

  it('tells a payee apart from the text of one', () => {
    expect(text).toContain('IF payee is Netflix');
    expect(text).toContain('IF payee is "Netflix"');
  });

  it('says where a value written as a template comes from', () => {
    // The stored value is empty, so the line read `= (none)` and the rule
    // looked broken. The engine reads the template instead.
    expect(text).toContain('THEN set amount = the template "{{ 5 }}"');
  });

  it('reads a split action instead of printing its operation twice', () => {
    // `THEN set-split-amount set-split-amount = 5000`, with the figure in the
    // smallest unit and nothing about which part it was for.
    expect(text).toContain('THEN set-split-amount = 50% of what is left (split 1)');
    expect(text).toContain('THEN set-split-amount = what is left (split 2)');
    expect(text).toContain('THEN set-split-amount = 25.00 (split 3)');
    expect(text).not.toContain('set-split-amount set-split-amount');
  });

  it('escapes a quote in a value, so one value cannot read as two', () => {
    expect(text).toContain('IF notes is "a\\", \\"b"');
  });
});
