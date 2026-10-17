import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

vi.mock('@actual-app/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@actual-app/api')>();
  return { ...actual, sync: vi.fn().mockResolvedValue(undefined) };
});
vi.mock('../../../connection.js', () => ({
  ensureConnection: vi.fn().mockResolvedValue(undefined),
}));

import { initTestEngine, shutdownTestEngine, createFreshBudget, api } from './actual-engine.js';
import { createRuleFromInput } from '../../write/create-rule.js';
import { registerGetRules } from '../../read/get-rules.js';

const skip = process.env.SKIP_ACTUAL_INTEGRATION === '1';

type Handler = (input: unknown) => Promise<{ content: Array<{ text: string }> }>;

function listing(): Handler {
  let handler: Handler | undefined;
  registerGetRules({
    tool: (...a: unknown[]) => {
      handler = a.at(-1) as Handler;
    },
  } as never);
  return handler as Handler;
}

/**
 * What `create_rule` says back about the rule it just made (#198).
 *
 * `get_rules` and `delete_rule` have written a rule the same way since
 * 0.10.6: a figure as a figure, a true or false bare, a name where an id is
 * stored, and quotes only on what the budget holds as text. This reply still
 * used the old form, so the call that made a working rule described it the
 * way the listing describes the broken one.
 *
 * Found in the live test of 0.10.6.
 */
describe.skipIf(skip)('what create_rule says back', () => {
  let payeeId = '';

  beforeAll(async () => {
    await initTestEngine();
    await createFreshBudget(async () => {
      await api.createAccount({ name: 'Checking', offbudget: false } as never, 0);
      payeeId = (await api.createPayee({ name: 'Amazon' } as never)) as string;
    }, 'create-rule-reply');
  }, 60_000);

  afterAll(async () => {
    await shutdownTestEngine();
  });

  it('writes a figure as a figure, not as the text of one', async () => {
    const lines = await createRuleFromInput({
      condition_field: 'notes',
      condition_op: 'is',
      condition_value: 'rent',
      action_field: 'amount',
      action_value: '-6.60',
    });
    const text = lines.join('\n');

    expect(text).toContain('THEN set amount = -6.60');
    // The quoted form is how the listing writes a rule that takes the next
    // import down, and the engine stored this one as a number.
    expect(text).not.toContain('"-6.60"');
    // The stored integer still earns its line: it is the reading that was
    // wrong in #183, and nothing else in the reply shows it.
    expect(text).toContain('stored as -660');
  }, 60_000);

  it('writes a true or false bare', async () => {
    const lines = await createRuleFromInput({
      condition_field: 'notes',
      condition_op: 'is',
      condition_value: 'paid',
      action_field: 'cleared',
      action_value: 'false',
    });
    const text = lines.join('\n');

    expect(text).toContain('THEN set cleared = false');
    expect(text, 'the quoted word is the form that means the opposite').not.toContain('"false"');
    // And what that does, which the line alone does not say.
    expect(text).toContain('marked not cleared');
  }, 60_000);

  it('names the payee and keeps its id out of the reply', async () => {
    const lines = await createRuleFromInput({
      condition_field: 'payee',
      condition_op: 'is',
      condition_value: 'amazon',
      action_field: 'notes',
      action_value: 'seen',
    });
    const text = lines.join('\n');

    expect(text).toContain('IF payee is Amazon');
    expect(text).toContain('THEN set notes = "seen"');
    expect(text, 'nobody can check a uuid').not.toContain(payeeId);
  }, 60_000);

  it('tells two things with one name apart', async () => {
    // A name that two of them answer to identifies neither, and the reply
    // said only the name. A category gets its group, since that is what tells
    // two of them apart in the app as well; anything else gets the id, which
    // is ugly and is the only thing left that is true.
    const group = await api.createCategoryGroup({ name: 'Home' } as never);
    const other = await api.createCategoryGroup({ name: 'Fun' } as never);
    const inHome = (await api.createCategory({ name: 'Water', group_id: group } as never)) as string;
    await api.createCategory({ name: 'Water', group_id: other } as never);
    const shop = (await api.createPayee({ name: 'Shop ' } as never)) as string;
    await api.createPayee({ name: 'shop' } as never);

    const byGroup = await createRuleFromInput({
      condition_field: 'notes',
      condition_op: 'is',
      condition_value: 'water',
      action_field: 'category',
      action_value: inHome,
    });
    expect(byGroup.join('\n')).toContain('THEN set category = Water in Home');

    const byId = await createRuleFromInput({
      condition_field: 'payee',
      condition_op: 'is',
      condition_value: shop,
      action_field: 'notes',
      action_value: 'seen',
    });
    // Trimmed and without case, because that is how these two read as one.
    expect(byId.join('\n')).toContain(`IF payee is Shop  (${shop})`);
  }, 60_000);

  it('leaves a name alone when nothing else answers to it', async () => {
    // An account and its transfer payee always share a name, so comparing
    // across kinds would put an id beside every account in every budget.
    const lines = await createRuleFromInput({
      condition_field: 'account',
      condition_op: 'is',
      condition_value: 'Checking',
      action_field: 'notes',
      action_value: 'seen',
    });

    expect(lines.join('\n')).toContain('IF account is Checking');
    expect(lines.join('\n')).not.toMatch(/IF account is Checking \(/);
  }, 60_000);

  it('says which payee is the one for transfers, and leaves the other alone', async () => {
    // Every account has a transfer payee carrying its name, so somebody with
    // a PayPal account and a PayPal payee has this collision as a matter of
    // course. Putting an id beside both read as two broken rules.
    await api.createAccount({ name: 'PayPal', offbudget: false } as never, 0);
    const shop = (await api.createPayee({ name: 'PayPal' } as never)) as string;
    const transfer = (await api.getPayees()).find(
      (p) => (p as { transfer_acct?: string }).transfer_acct && p.name === 'PayPal',
    )!.id;

    const ordinary = await createRuleFromInput({
      condition_field: 'payee',
      condition_op: 'is',
      condition_value: shop,
      action_field: 'notes',
      action_value: 'seen',
    });
    expect(ordinary.join('\n')).toContain('IF payee is PayPal');
    expect(ordinary.join('\n'), 'the ordinary one is left as it was').not.toContain(shop);

    const moved = await createRuleFromInput({
      condition_field: 'payee',
      condition_op: 'is',
      condition_value: transfer,
      action_field: 'notes',
      action_value: 'moved',
    });
    expect(moved.join('\n')).toContain('IF payee is PayPal (transfer)');
    expect(moved.join('\n')).not.toContain(transfer);
  }, 60_000);

  it('still says it was created when the names cannot be read', async () => {
    // The rule exists by then. Answering `Error` invites the caller to try
    // again, and trying again writes a second rule.
    // From the second call on: the first one resolves the name to an id,
    // before anything is created, and failing there is an error with nothing
    // written, which is right. The one after it is the lookup that only
    // exists to make the reply readable.
    const real = api.getPayees;
    let calls = 0;
    (api as { getPayees: unknown }).getPayees = async (...args: unknown[]) => {
      calls += 1;
      if (calls > 1) throw new Error('database is locked');
      return (real as (...a: unknown[]) => unknown)(...args);
    };
    let text = '';
    try {
      const lines = await createRuleFromInput({
        condition_field: 'payee',
        condition_op: 'is',
        condition_value: 'Amazon',
        action_field: 'notes',
        action_value: 'seen',
      });
      text = lines.join('\n');
    } finally {
      (api as { getPayees: unknown }).getPayees = real;
    }

    expect(text).toContain('Rule created:');
    expect(text).toContain('could not be read just now');
  }, 60_000);

  it('says it the way the listing says it, line for line', async () => {
    // The strongest form: the same lines, from the same code. Three tools
    // describing one rule in three ways is what #185 and #186 each found, and
    // the one that looked right was the wrong one both times.
    const lines = await createRuleFromInput({
      condition_field: 'payee',
      condition_op: 'is',
      condition_value: 'Amazon',
      action_field: 'amount',
      action_value: '-12.34',
    });
    const id = lines.find((line) => line.startsWith('  ID: '))!.slice('  ID: '.length);

    const listed = (await listing()({})).content[0].text.split('\n');
    const from = listed.indexOf(`Rule: ${id}`);
    expect(from, 'the rule has to be in the listing to compare against').toBeGreaterThanOrEqual(0);
    const body = listed.slice(from + 2, listed.indexOf('', from + 2));
    expect(body.length, 'a condition and an action to compare').toBeGreaterThan(1);

    expect(lines.join('\n')).toContain(body.join('\n'));
  }, 60_000);
});
