import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import * as api from '@actual-app/api';
import { ensureConnection } from '../../connection.js';
import { resolvePayeeIn, resolveByWholeName } from '../../utils/resolvers.js';
import { amountToCents, formatMoney } from '../../utils/money.js';
import { describeError } from '../../utils/errors.js';
import {
  AMOUNT_OPS,
  refuseOpOnAmount,
  ID_FIELDS,
  LIST_FIELDS,
  isTextOpOnIdField,
  refuseTextOpOnIdField,
  refuseListOnField,
} from '../../utils/rule-fields.js';
import { syncNow } from '../../utils/sync-clock.js';

export interface CreateRuleInput {
  condition_field: string;
  condition_op: string;
  /** A list for `oneOf` and `notOneOf`, a single value for everything else. */
  condition_value: string | string[];
  action_field: string;
  action_value: string;
  stage?: string;
}

/** The operators whose value is a list of ids rather than one (#171). */
const LIST_OPS = new Set(['oneOf', 'notOneOf']);

/**
 * A payee value as Actual stores it in a rule: the payee's id, and the name it
 * belongs to.
 *
 * Actual stores `payee` in a rule as an id. The name used to be saved as
 * typed, so "IF payee is Amazon" was reported as created and never matched,
 * because transactions hold the id. Tested against the engine: an imported
 * Amazon transaction stayed uncategorised under exactly that rule.
 *
 * An id, or a name in full. Not part of a name, which the tools that resolve
 * an account or a category do accept: those answer one call, and this is
 * stored and keeps running until somebody deletes it. "Uber" saved as "Uber
 * Eats", because that was the only payee containing it, recategorises
 * transactions for months under a rule whose reply said "Uber".
 *
 * A payee that does not exist is refused on both sides. A condition on it
 * could never match, and an action used to create it, so a typo like "Amazn"
 * quietly became a new payee that the rule then moved transactions to.
 *
 * The name comes back as well so the reply can say which payee this turned
 * out to be, which is the other half of the same problem: the caller typed
 * something, and what the rule holds is an id they cannot read.
 */
async function resolveRulePayee(value: string): Promise<{ id: string; name: string }> {
  const payees = await api.getPayees();
  const id = resolvePayeeIn(payees, value);
  return { id, name: payees.find((p) => p.id === id)?.name ?? value };
}

/**
 * The fields that hold an amount, which Actual keeps as an integer.
 *
 * One of them: the engine's own field table has a single numeric field,
 * `amount`. A value typed as a human writes it has to become that integer
 * before it is saved, and what happens when it does not was measured both
 * ways:
 *
 *   condition `amount is "-45.50"`   the engine refuses the rule outright,
 *                                    "Value must be a number or between",
 *                                    and the tool answered with a bare
 *                                    "Failed creating a new rule". So no rule
 *                                    about an amount could be made here at all.
 *
 *   action `set amount = "-45.50"`   saved without complaint, and then every
 *                                    import that matched it died on
 *                                    `Can't convert to integer: "-45.50"`.
 *                                    The rule sits there breaking imports.
 *
 * The amount is read the way every other amount this server takes is read, in
 * the budget's own units: 45.50, not 4550.
 */
const AMOUNT_FIELDS: ReadonlySet<string> = new Set(['amount']);

function amountForRule(field: string, value: string): number {
  // Trimmed before anything else, so the emptiness check below sees a value
  // of spaces for what it is.
  const text = value.trim();

  // Empty first, and on its own, because `Number("")` and `Number("   ")` are
  // both 0 and 0 passes every check after this one. Measured: an action
  // `set amount = ""` was saved, and then each import that matched it moved a
  // row of -100 to 0. A figure nobody typed, losing data quietly, every time.
  if (text === '') {
    throw new Error(
      `\`${field}\` needs a figure. An empty value would be saved as 0, which sets ` +
        `matching transactions to nothing.`,
    );
  }

  // A plain decimal, and nothing else. `Number` is far more generous than
  // anyone writing an amount means it to be: "0x10" is 16, "1e3" is 1000, and
  // "1e20" is past the point where an integer is exact.
  if (!/^[-+]?\d+(\.\d+)?$/.test(text)) {
    throw new Error(
      `\`${field}\` takes a figure like 45.50 or -45.50, and "${value}" is not one. ` +
        `Write it the way you would say it, not in cents and not in any other notation.`,
    );
  }

  // How many decimals fit is the conversion's own answer: `amountToCents(1)`
  // is 100 where there are two of them and 1 where the currency has none, so
  // this follows the budget without repeating the table.
  const places = String(amountToCents(1)).length - 1;
  const written = (text.split('.')[1] ?? '').length;
  if (written > places) {
    throw new Error(
      places === 0
        ? `\`${field}\` takes a whole figure in this budget's currency, and "${value}" has ` +
            `decimals.`
        : `\`${field}\` takes at most ${places} decimal${places === 1 ? '' : 's'} in this ` +
            `budget's currency, and "${value}" has ${written}. Rounding it here would save a ` +
            `figure you did not write.`,
    );
  }

  return amountToCents(Number(text));
}

/**
 * One value of one of the fields the engine stores by id, resolved to that id.
 *
 * All four match the same way, by id or by the whole name: a rule is stored
 * and keeps running, so a name matched loosely in one field and strictly in
 * another is a difference nobody sees until a rule does something nobody
 * asked for.
 *
 * Closed accounts are left out of the name match, which is what every other
 * tool here does. The filter is belt and braces, the same as the one in
 * `transfer-rule.ts`: measured, `getAccounts()` does not return a closed
 * account at all, so its name falls through whatever this says. A rule on one
 * is still possible by id, and the engine accepts it.
 */
async function resolveRuleFieldValue(
  field: string,
  value: string,
): Promise<{ id: string; name: string }> {
  if (field === 'payee') return resolveRulePayee(value);

  if (field === 'category') {
    const categories = (await api.getCategories()).filter((c) => 'group_id' in c);
    const id = resolveByWholeName(categories, categories, value, 'category');
    return { id, name: categories.find((c) => c.id === id)?.name ?? value };
  }
  if (field === 'category_group') {
    const groups = await api.getCategoryGroups();
    const id = resolveByWholeName(groups, groups, value, 'category group');
    return { id, name: groups.find((g) => g.id === id)?.name ?? value };
  }
  if (field === 'account') {
    const accounts = await api.getAccounts();
    const open = accounts.filter((a) => !(a as { closed?: boolean }).closed);
    const id = resolveByWholeName(accounts, open, value, 'account');
    return { id, name: accounts.find((a) => a.id === id)?.name ?? value };
  }
  return { id: value, name: value };
}

/**
 * A rule value, which is one id or a list of them.
 *
 * `oneOf` and `notOneOf` take an array: measured, the engine accepts
 * `["<id>"]` on all four id fields and rejects a single string outright, with
 * a bare "Failed creating a new rule" (#171). A caller passing one string to
 * `oneOf` meant a list of one, so it becomes one rather than an error.
 */
async function resolveRuleValue(
  field: string,
  op: string,
  value: string | string[],
): Promise<{ stored: string | string[] | number; matched: string[] }> {
  const list = Array.isArray(value) ? value : [value];

  // Refused here rather than by the engine, which answers a list on the wrong
  // field with a bare "Failed creating a new rule" and says nothing about
  // which part was wrong. Measured, one rule per field: the four id fields
  // plus payee_name and imported_payee take a list, and nothing else does.
  if (LIST_OPS.has(op) && !LIST_FIELDS.has(field)) {
    throw new Error(refuseListOnField(field, op));
  }

  if (!LIST_OPS.has(op) && Array.isArray(value)) {
    throw new Error(
      `\`${op}\` takes one value, not a list. Use \`oneOf\` or \`notOneOf\` to match ` +
        `several, or send a single value.`,
    );
  }
  if (list.length === 0) {
    throw new Error(`\`${op}\` needs at least one value.`);
  }

  // After the list checks, which already say the useful thing about `oneOf`
  // on a field that cannot take one (#171), and before anything is saved.
  if (AMOUNT_FIELDS.has(field)) {
    // Refused here rather than by the engine, which answers an operator it
    // does not take on a number with the same bare "Failed creating a new
    // rule" this tool exists to stop handing over. Measured: `isNot` is one
    // of them, and it was being offered in this tool's own advice.
    if (!AMOUNT_OPS.has(op)) {
      throw new Error(refuseOpOnAmount(field, op));
    }
    const cents = amountForRule(field, list[0]);
    // Said back, because the reading is the thing that was wrong: 45.50 is
    // forty five and a half, not forty five cents, and a rule runs until
    // somebody deletes it.
    return { stored: cents, matched: [`${formatMoney(cents)}, stored as ${cents}`] };
  }

  if (!ID_FIELDS.has(field)) {
    return { stored: LIST_OPS.has(op) ? list : list[0], matched: [] };
  }

  // Every element, and any one of them failing stops the whole rule: half a
  // list silently saved is a rule that does part of what was asked.
  const resolved = [];
  for (const item of list) resolved.push(await resolveRuleFieldValue(field, item));

  return {
    stored: LIST_OPS.has(op) ? resolved.map((r) => r.id) : resolved[0].id,
    matched: resolved.map((r) => `${r.name} (${r.id})`),
  };
}

/**
 * Build the rule from the tool's flat input and create it.
 *
 * Returns the lines reported back to the caller.
 */
export async function createRuleFromInput(input: CreateRuleInput): Promise<string[]> {
  const { condition_field, condition_op, condition_value, action_field, action_value } = input;
  const stage = input.stage ?? 'null';

  await ensureConnection();

  // Refused before anything is resolved or created (#169). The engine accepts
  // these and the rule then fires on the wrong transactions, with nothing
  // saying so: a rule is stored, so this is the one chance to stop it.
  if (isTextOpOnIdField(condition_field, condition_op)) {
    throw new Error(refuseTextOpOnIdField(condition_field, condition_op));
  }

  // Every field the engine stores by id is resolved, in conditions and in
  // actions (#167, #170). A name saved as typed is a rule that is reported as
  // created and never matches anything.
  const condition = await resolveRuleValue(condition_field, condition_op, condition_value);
  const resolvedCondValue: unknown = condition.stored;

  const action = await resolveRuleValue(action_field, 'is', action_value);
  const resolvedActionValue: unknown = action.stored;

  const rule = {
    stage: stage === 'null' ? null : stage,
    conditionsOp: 'and' as const,
    conditions: [
      {
        field: condition_field,
        op: condition_op,
        value: resolvedCondValue,
      },
    ],
    actions: [
      {
        op: 'set' as const,
        field: action_field,
        value: resolvedActionValue,
      },
    ],
  };

  const result = await api.createRule(rule as any);
  await syncNow();

  // What each name turned out to be, said rather than left to be trusted. The
  // caller typed names and the rule holds ids, so one that matched something
  // they did not have in mind is invisible otherwise, and a rule runs until
  // somebody deletes it.
  const matched: string[] = [];
  if (action_field === 'account') {
    // Measured, and worth saying every time: the action really moves the
    // transaction, and the engine's importer does not recognise a row it has
    // moved. Re-importing the same `imported_id` then leaves two rows, which
    // for anyone syncing a bank on a schedule is a duplicate per sync.
    matched.push(
      '',
      'This action moves transactions to another account. Two things follow from that,',
      'both measured: a row the rule has moved is not recognised when the same movement is',
      'imported again, so a bank sync can leave a second copy of it; and a row moved to an',
      'off-budget account loses its category.',
      '',
    );
  }
  if (condition.matched.length > 0) {
    matched.push(`  Condition ${condition_field}: ${condition.matched.join(', ')}`);
  }
  if (action.matched.length > 0) {
    matched.push(`  Action ${action_field}: ${action.matched.join(', ')}`);
  }

  return [
    'Rule created:',
    `  IF ${condition_field} ${condition_op} "${
      Array.isArray(condition_value) ? condition_value.join('", "') : condition_value
    }"`,
    `  THEN set ${action_field} = "${action_value}"`,
    ...matched,
    `  ID: ${(result as any).id}`,
  ];
}

export function registerCreateRule(server: McpServer): void {
  server.tool(
    'create_rule',
    'Create a transaction rule. When a transaction matches the condition, the action is applied automatically.',
    {
      condition_field: z
        .string()
        .describe(
          'Field to match: payee, payee_name, category, category_group, account, amount, ' +
            'notes, imported_payee',
        ),
      condition_op: z
        .string()
        .describe(
          'Operator: is, isNot, oneOf, notOneOf, contains, doesNotContain, matches, gt, lt, ' +
            'gte, lte. oneOf and notOneOf take a list. contains, doesNotContain and matches ' +
            'are refused on payee, category, category_group and account, which Actual stores ' +
            'as ids: they would compare against the id. For text on a payee, imported_payee ' +
            'holds what the row arrived with, and payee_name the payee name, once that payee ' +
            'exists. On amount the operators are is, isapprox, gt, gte, lt and lte; isNot is ' +
            'not one of them.',
        ),
      condition_value: z
        .union([z.string(), z.array(z.string())])
        .describe(
          'Value to match against. For payee, category, category_group and account, a whole ' +
            'name or an ID. For amount, the figure as you would say it (45.50, or -45.50 for ' +
            'money going out), not in cents. Spending is negative, so "more than 45.50 spent" ' +
            'is lt -45.50: gt -45.50 would also catch every deposit and every zero. Pass a ' +
            'list for oneOf and notOneOf; a single value for every other operator.',
        ),
      action_field: z
        .string()
        .describe(
          'Field to set: category, payee, notes, account. Setting account moves the ' +
            'transaction, which a later import of the same movement does not recognise, so ' +
            'a bank sync can leave a duplicate; a row moved off budget also loses its ' +
            'category.',
        ),
      action_value: z
        .string()
        .describe(
          'Value to set (category name/ID, payee name/ID, account name/ID, note text, or an ' +
            'amount as you would say it). A payee, category or account must already exist; ' +
            'use create_payee or create_category for a new one.',
        ),
      stage: z.string().optional().default('null').describe('When to apply: null (default), pre, or post'),
    },
    { title: 'Create automation rule', readOnlyHint: false },
    async (input) => {
      try {
        const lines = await createRuleFromInput(input);
        return { content: [{ type: 'text', text: lines.join('\n') }] };
      } catch (error) {
        const message = describeError(error);
        return { content: [{ type: 'text', text: `Error: ${message}` }], isError: true };
      }
    },
  );
}
