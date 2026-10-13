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
 * What `get_rules` says about the rules that are already broken (#185).
 *
 * `create_rule` refuses these now, which does nothing for the ones saved
 * before it did. They are the dangerous half, because the listing read them
 * back as if they were fine: a word where Actual keeps true or false prints
 * as `false` and means true, and `delete_rule`, which prints the same value
 * through `JSON.stringify`, showed `"false"`. Two views of one rule that did
 * not agree, and the one that looked right was the wrong one.
 */
describe.skipIf(skip)('listing a rule that was saved broken (#185)', () => {
  let text = '';

  beforeAll(async () => {
    await initTestEngine();
    await createFreshBudget(async () => {
      await api.createAccount({ name: 'Checking', offbudget: false } as never, 0);
    }, 'rule-warnings');

    // Written around the tool on purpose: this is what is already in people's
    // budgets, and what the tool will not write again.
    await api.createRule({
      stage: null,
      conditionsOp: 'and',
      conditions: [{ field: 'notes', op: 'is', value: 'the word' }],
      actions: [{ op: 'set', field: 'cleared', value: 'false' }],
    } as never);
    await api.createRule({
      stage: null,
      conditionsOp: 'and',
      conditions: [{ field: 'notes', op: 'is', value: 'nothing at all' }],
      actions: [{ op: 'set', field: 'reconciled', value: '' }],
    } as never);
    await api.createRule({
      stage: null,
      conditionsOp: 'and',
      conditions: [{ field: 'transfer', op: 'is', value: true }],
      actions: [{ op: 'set', field: 'notes', value: 'never runs' }],
    } as never);
    // A figure held as the text of one (#183), which is the third of the
    // three and the one that costs the most.
    await api.createRule({
      stage: null,
      conditionsOp: 'and',
      conditions: [{ field: 'notes', op: 'is', value: 'the text of a figure' }],
      actions: [{ op: 'set', field: 'amount', value: '-555' }],
    } as never);
    // And the same rule written properly, which must not be marked: the
    // listing prints both of these as money, so they look identical there.
    await api.createRule({
      stage: null,
      conditionsOp: 'and',
      conditions: [{ field: 'notes', op: 'is', value: 'a real figure' }],
      actions: [{ op: 'set', field: 'amount', value: -555 }],
    } as never);
    // And a figure whose value comes from a template, which is the app's
    // own editor again and is stored exactly like the broken one: an empty
    // string, with the value kept somewhere else.
    await api.createRule({
      stage: null,
      conditionsOp: 'and',
      conditions: [{ field: 'notes', op: 'is', value: 'a figure from a template' }],
      actions: [{ op: 'set', field: 'amount', value: '', options: { template: '-555' } }],
    } as never);
    // A rule the app's own editor writes: the value lives in the template and
    // the engine never reads the one stored beside it. Measured, a template
    // of `true` on cleared marks the transaction, with "" saved as the value.
    await api.createRule({
      stage: null,
      conditionsOp: 'and',
      conditions: [{ field: 'notes', op: 'is', value: 'from a template' }],
      actions: [
        { op: 'set', field: 'cleared', value: '', options: { template: 'true' } },
      ],
    } as never);
    // The same, from a formula rather than a template.
    await api.createRule({
      stage: null,
      conditionsOp: 'and',
      conditions: [{ field: 'notes', op: 'is', value: 'from a formula' }],
      actions: [
        { op: 'set', field: 'reconciled', value: '', options: { formula: 'true' } },
      ],
    } as never);
    // One that is right, to be sure the marking is about the rule and not
    // about every line that mentions a boolean.
    await api.createRule({
      stage: null,
      conditionsOp: 'and',
      conditions: [{ field: 'cleared', op: 'is', value: true }],
      actions: [{ op: 'set', field: 'cleared', value: false }],
    } as never);

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

  it('marks a word stored where Actual keeps true or false', () => {
    expect(text).toContain('this holds the word "false"');
    // The reading, not just the shape: this is the rule that marks
    // transactions cleared while reading as the opposite.
    expect(text).toContain('reads anything that is not empty as true');
  });

  it('marks a condition Actual will not run on its own', () => {
    expect(text).toContain('Actual never runs this rule on its own');
    expect(text).toContain('nothing on import or on a bank sync');
    // Not "it never fires": the conditions become a query when a rule is
    // applied by hand from the rules page, and there `transfer` does match.
    // Telling somebody to delete it would be telling them to delete the one
    // thing that works.
    expect(text).toContain('applied it by hand from the rules page');
    expect(text).not.toContain('has never fired');
  });

  it('says what an empty value does, not only that it is empty', () => {
    expect(text).toContain('marks every transaction it matches as not reconciled');
  });

  it('leaves a rule whose value comes from a template alone', () => {
    // The empty value is not what is wrong with it: the engine reads the
    // template and never looks at the stored value. Marking a rule somebody
    // made in the app is how people learn to ignore the marks.
    const line = text.split('\n').findIndex((l) => l.includes('from a template'));
    expect(line, 'the template rule is not in the listing').toBeGreaterThan(-1);
    expect(text.split('\n')[line + 2] ?? '', 'the template rule was marked').not.toContain(
      'warning:',
    );
  });

  it('leaves a formula alone as well as a template', () => {
    // Two different ways the app writes the value somewhere else, and the
    // engine reads the stored value in neither.
    const line = text.split('\n').findIndex((l) => l.includes('from a formula'));
    expect(line, 'the formula rule is not in the listing').toBeGreaterThan(-1);
    expect(text.split('\n')[line + 2] ?? '', 'the formula rule was marked').not.toContain(
      'warning:',
    );
  });

  it('marks a figure held as the text of one', () => {
    expect(text).toContain('this holds the text "-555" where Actual keeps a figure');
    expect(text).toContain("Can't convert to integer");
    expect(text).toContain('none of the batch arrives');
  });

  it('leaves a figure that comes from a template alone', () => {
    // Stored as an empty string, exactly like the broken one, with the value
    // in the template. Telling them apart is the whole of this check.
    const line = text.split('\n').findIndex((l) => l.includes('a figure from a template'));
    expect(line, 'the template rule is not in the listing').toBeGreaterThan(-1);
    expect(text.split('\n')[line + 2] ?? '', 'the template rule was marked').not.toContain(
      'warning:',
    );
  });

  it('leaves the same rule written properly alone', () => {
    // Both print as money in the listing, so this is the pair that cannot be
    // told apart by reading it. Marking the right one would be marking every
    // rule anybody has about an amount.
    const line = text.split('\n').findIndex((l) => l.includes('a real figure'));
    expect(line, 'the correct rule is not in the listing').toBeGreaterThan(-1);
    expect(text.split('\n')[line + 2] ?? '', 'the correct rule was marked').not.toContain(
      'warning:',
    );
  });

  it('leaves a rule that is right alone', () => {
    // Nine rules, four marked. The other five are a figure written properly,
    // a figure from a template, a template, a formula, and real booleans on
    // both sides.
    const marked = text.split('\n').filter((line) => line.includes('warning:'));
    expect(marked).toHaveLength(4);
    expect(text).toContain('4 lines above are marked');
  });
});
