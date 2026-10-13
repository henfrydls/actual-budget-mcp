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
 * The paragraph that closes a listing, against the rules that are in it.
 *
 * It used to name every kind this tool can find, whatever was actually found.
 * A budget whose only marked rule compares text against an id was told that
 * some of them take the next import down with them, which was false there and
 * read exactly like the one sentence that did apply. Nothing in the suite
 * noticed, because every test ran against a listing that had one of each.
 */
describe.skipIf(skip)('what the closing line says, and about which rules', () => {
  beforeAll(async () => {
    await initTestEngine();
  }, 60_000);

  afterAll(async () => {
    await shutdownTestEngine();
  });

  /** A fresh budget holding exactly these rules, listed. */
  async function listingOf(prefix: string, rules: unknown[]): Promise<string> {
    await createFreshBudget(async () => {
      await api.createAccount({ name: 'Checking', offbudget: false } as never, 0);
    }, prefix);
    for (const rule of rules) await api.createRule(rule as never);

    let handler: (() => Promise<{ content: { text: string }[] }>) | undefined;
    registerGetRules({
      tool: (...a: unknown[]) => {
        handler = a.at(-1) as never;
      },
    } as never);
    return (await handler!()).content[0].text;
  }

  const comparesTextToAnId = {
    stage: null,
    conditionsOp: 'and',
    conditions: [{ field: 'payee', op: 'contains', value: 'Land' }],
    actions: [{ op: 'set', field: 'notes', value: 'seen' }],
  };
  const breaksTheImport = {
    stage: null,
    conditionsOp: 'and',
    conditions: [{ field: 'notes', op: 'is', value: 'poison' }],
    actions: [{ op: 'set', field: 'transfer', value: true }],
  };

  it('says only what is in the budget it is describing', async () => {
    const text = await listingOf('summary-one', [comparesTextToAnId]);

    expect(text).toContain('1 line above is marked');
    expect(text).toContain('fires on transactions it has nothing to do with');
    // None of these is in that budget, and saying them is what made the one
    // that was true impossible to pick out.
    expect(text, 'it claims an import is broken').not.toContain('takes the next import down');
    expect(text, 'it claims a rule sets something to zero').not.toContain('to zero');
    expect(text, 'it claims a rule never runs').not.toContain('never runs on its own');
    expect(text).toContain('create_rule refuses it now');
  });

  it('says the other one when that is what is there', async () => {
    const text = await listingOf('summary-two', [breaksTheImport]);

    expect(text).toContain('takes the next import down with it');
    expect(text, 'it talks about ids in a budget with no such rule').not.toContain(
      'internal id',
    );
  });

  it('puts the import first when both are there', async () => {
    const text = await listingOf('summary-both', [comparesTextToAnId, breaksTheImport]);

    expect(text).toContain('2 lines above are marked');
    const closing = text.split('\n').find((l) => l.includes('lines above are marked'))!;
    expect(closing.indexOf('takes the next import down')).toBeGreaterThan(-1);
    expect(closing.indexOf('internal id')).toBeGreaterThan(-1);
    // Nothing about a failed import points back at the rule, so it is the one
    // to deal with first and the one to read first.
    expect(closing.indexOf('takes the next import down')).toBeLessThan(
      closing.indexOf('internal id'),
    );
    expect(text).toContain('create_rule refuses all of them now');
  });

  it('marks a figure held as nothing, and says it is the import that works', async () => {
    // Measured: with `set amount = null` the import goes through, the row
    // beside it arrives, and the matching row lands at 0. The money is gone
    // and nothing failed, which is what makes it worth marking.
    const text = await listingOf('summary-zero', [
      {
        stage: null,
        conditionsOp: 'and',
        conditions: [{ field: 'notes', op: 'is', value: 'zero me' }],
        actions: [{ op: 'set', field: 'amount', value: null }],
      },
    ]);

    expect(text).toContain('this holds nothing where Actual keeps a figure');
    expect(text).toContain('sets every transaction it matches to zero');
    // The cost is the opposite of the other figure fault, and saying the
    // wrong one sends someone looking for a failed import that never happened.
    expect(text).toContain('The import goes through');
    expect(text).not.toContain("Can't convert to integer");
  });

  it('leaves a figure whose value is in a template alone, even with nothing beside it', async () => {
    // Measured, the engine stores this shape: `value: null` with the figure
    // in the template. It does not set anything to zero, because the stored
    // value is never read when there is a template, so the warning above
    // would be false here.
    const text = await listingOf('summary-null-template', [
      {
        stage: null,
        conditionsOp: 'and',
        conditions: [{ field: 'notes', op: 'is', value: 'from a template' }],
        actions: [
          { op: 'set', field: 'amount', value: null, options: { template: '-555' } },
        ],
      },
    ]);

    expect(text, 'the rule is not in the listing at all').toContain('from a template');
    expect(text, 'a template rule was marked as holding nothing').not.toContain('warning:');
  });

  it('leaves a figure that is really there alone', async () => {
    const text = await listingOf('summary-fine', [
      {
        stage: null,
        conditionsOp: 'and',
        conditions: [{ field: 'notes', op: 'is', value: 'a real figure' }],
        actions: [{ op: 'set', field: 'amount', value: -4550 }],
      },
    ]);

    expect(text, 'a correct rule was marked').not.toContain('warning:');
    expect(text).not.toContain('above is marked');
  });
});
