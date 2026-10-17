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
  BOOLEAN_FIELDS,
  BOOLEAN_OPS,
  MATCHABLE_FIELDS,
  SETTABLE_FIELDS,
  describeBooleanField,
  refuseMatchingField,
  refuseOpOnBoolean,
  refuseSettingField,
  ID_FIELDS,
  LIST_FIELDS,
  isTextOpOnIdField,
  refuseTextOpOnIdField,
  refuseListOnField,
  refuseListValue,
} from '../../utils/rule-fields.js';
import { syncNow } from '../../utils/sync-clock.js';
import { loadRuleNames, describeRule, type RuleNames } from '../../utils/rule-describe.js';

/**
 * One value as a client sends it.
 *
 * The tool reads every value as text, and a client filling these from JSON
 * writes `true` and `1` as a boolean and a number without thinking about it.
 * Measured: the schema answered `action_value: true` with "Expected string,
 * received boolean", which says nothing about the rule, and called directly it
 * reached `value.trim` and threw `value.trim is not a function`.
 */
export type RuleValue = string | number | boolean;

export interface CreateRuleInput {
  condition_field: string;
  condition_op: string;
  /** A list for `oneOf` and `notOneOf`, a single value for everything else. */
  condition_value: RuleValue | RuleValue[];
  action_field: string;
  action_value: RuleValue;
  stage?: string;
}

/** A value of any of those shapes, as the text everything here reads. */
function asText(value: RuleValue): string {
  return typeof value === 'string' ? value : String(value);
}

/** The operators whose value is a list of ids rather than one (#171). */
const LIST_OPS = new Set(['oneOf', 'notOneOf']);

/**
 * What a rule value may arrive as.
 *
 * Text, and the two shapes a client writes without thinking: `true` for a
 * boolean field and `1` for a figure. Both are read as the text they spell,
 * so nothing downstream has to know they were ever anything else.
 */
const RULE_VALUE = z.union([z.string(), z.boolean(), z.number()]);

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

function amountForRule(field: string, value: string, role: 'condition' | 'action'): number {
  // Trimmed before anything else, so the emptiness check below sees a value
  // of spaces for what it is.
  const text = value.trim();

  // Empty first, and on its own, because `Number("")` and `Number("   ")` are
  // both 0 and 0 passes every check after this one. Measured: an action
  // `set amount = ""` was saved, and then each import that matched it moved a
  // row of -100 to 0. A figure nobody typed, losing data quietly, every time.
  if (text === '') {
    // What a zero would do differs by where it is, and saying the wrong one
    // sends the reader looking for the wrong thing.
    throw new Error(
      role === 'action'
        ? `\`${field}\` needs a figure. An empty value would be saved as 0, which sets ` +
            `every matching transaction to nothing.`
        : `\`${field}\` needs a figure. An empty value would be saved as 0, so the rule ` +
            `would match transactions of exactly zero.`,
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

  const cents = amountToCents(Number(text));
  // A figure so large that the integer is no longer exact: "100000000000000000000"
  // is a plain decimal and converts to 1e+22, which is not a figure anybody
  // can be stored or compared against meaningfully.
  if (!Number.isSafeInteger(cents)) {
    throw new Error(
      `\`${field}\` cannot hold ${text}: it is past the largest figure that stays exact.`,
    );
  }
  return cents;
}

/**
 * A true or false typed as a word, read as the boolean the engine stores.
 *
 * The tool takes one string for a value, and the engine takes a boolean on
 * these fields and nothing else. What happened in between was measured on both
 * halves of a rule, and they failed differently because the engine checks a
 * condition's value and does not check an action's:
 *
 *   condition `cleared is "true"`   refused outright, which reached the caller
 *                                   as a bare "Failed creating a new rule". No
 *                                   rule about a cleared transaction could be
 *                                   written here at all.
 *
 *   action `set cleared = "false"`  saved as the word, and then read for its
 *                                   truth: a non-empty string is true, so the
 *                                   rule marked every transaction it matched
 *                                   as cleared. The opposite of what was
 *                                   asked, quietly, on every import.
 *
 * Measured, importing rows that start uncleared: "true", "false" and "banana"
 * all left the row cleared, and only the empty string left it alone. So "0"
 * meant true as well, which is why 0 is one of the words read as false here
 * rather than passed through.
 */
const TRUE_WORDS: ReadonlySet<string> = new Set(['true', 'yes', '1']);
const FALSE_WORDS: ReadonlySet<string> = new Set(['false', 'no', '0']);

function booleanForRule(field: string, value: string, role: 'condition' | 'action'): boolean {
  const text = value.trim().toLowerCase();
  if (TRUE_WORDS.has(text)) return true;
  if (FALSE_WORDS.has(text)) return false;

  // Empty on its own, because it is the one value that was being accepted and
  // acted on. Measured: `set cleared = ""` was stored as written and read as
  // false, so the rule marked matching transactions not cleared, and nothing
  // anywhere said that was what had been asked for.
  if (text === '') {
    // What a zero-like value would do differs by where it is, and the
    // abstract version of this sentence left the reader to work out which.
    const phrase = describeBooleanField(field);
    throw new Error(
      `\`${field}\` needs true or false, and nothing was given. An empty value is read as ` +
        (role === 'action'
          ? `false, so the rule would mark every transaction it matches as not ${phrase}.`
          : `false, so the rule would match only transactions that are not ${phrase}.`),
    );
  }

  throw new Error(
    `\`${field}\` is true or false, and "${value}" is neither. Write true, yes or 1 for ` +
      `one, and false, no or 0 for the other. Stored as written, "${value}" would have ` +
      `been read as true, because anything that is not empty is.`,
  );
}

/**
 * The reading said back, which is the half that was silently wrong.
 *
 * A rule is stored and keeps running until somebody deletes it, so the reply
 * is where the writer gets to see that "false" means not cleared and not, as
 * it did, cleared.
 */
function describeBooleanValue(
  field: string,
  value: boolean,
  role: 'condition' | 'action',
): string {
  const phrase = describeBooleanField(field);
  if (role === 'action') {
    return value
      ? `true, so matching transactions are marked ${phrase}`
      : `false, so matching transactions are marked not ${phrase}`;
  }
  return value
    ? `true, so the rule matches transactions that are ${phrase}`
    : `false, so the rule matches transactions that are not ${phrase}`;
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
  value: RuleValue | RuleValue[],
  role: 'condition' | 'action' = 'condition',
): Promise<{ stored: string | string[] | number | boolean; matched: string[] }> {
  const list = (Array.isArray(value) ? value : [value]).map(asText);

  // Refused here rather than by the engine, which answers a list on the wrong
  // field with a bare "Failed creating a new rule" and says nothing about
  // which part was wrong. Measured, one rule per field: the four id fields
  // plus payee_name and imported_payee take a list, and nothing else does.
  if (LIST_OPS.has(op) && !LIST_FIELDS.has(field)) {
    throw new Error(refuseListOnField(field, op));
  }

  // Not "use `oneOf`", which is refused outright on most fields: naming an
  // operator the engine will not take here is the same broken promise as
  // sending someone to `isNot` on a figure or a truth.
  if (!LIST_OPS.has(op) && Array.isArray(value)) {
    throw new Error(refuseListValue(field, op));
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
    const cents = amountForRule(field, list[0], role);
    // Said back, because the reading is the thing that was wrong: 45.50 is
    // forty five and a half, not forty five cents, and a rule runs until
    // somebody deletes it.
    // The stored integer beside the figure, because that reading is what was
    // wrong in #183. In a currency with no decimal places the two are the
    // same number, and `-980, stored as -980` says nothing twice.
    // Compared as numbers, not as text: `formatMoney` groups the thousands,
    // so `1,500` and `1500` are the same figure written two ways and the
    // line said it twice anyway.
    const money = formatMoney(cents);
    const sameFigure = Number(money.replace(/,/g, '')) === cents;
    return {
      stored: cents,
      matched: sameFigure ? [] : [`${money}, stored as ${cents}`],
    };
  }

  if (BOOLEAN_FIELDS.has(field)) {
    // Refused here rather than by the engine, which answers every operator but
    // `is` with the same bare "Failed creating a new rule" this tool exists to
    // stop handing over.
    if (!BOOLEAN_OPS.has(op)) {
      throw new Error(refuseOpOnBoolean(field, op));
    }
    const truth = booleanForRule(field, list[0], role);
    return { stored: truth, matched: [describeBooleanValue(field, truth, role)] };
  }

  if (!ID_FIELDS.has(field)) {
    return { stored: LIST_OPS.has(op) ? list : list[0], matched: [] };
  }

  // Every element, and any one of them failing stops the whole rule: half a
  // list silently saved is a rule that does part of what was asked.
  const resolved = [];
  for (const item of list) resolved.push(await resolveRuleFieldValue(field, item));

  // No line of its own any more. What each name turned out to be is the
  // thing worth saying, and the rule is now written out the way `get_rules`
  // writes it, which names the id it holds: `IF payee is Shop`. Repeating
  // that underneath added the uuid and nothing else, and the listing stopped
  // showing uuids in 0.10.6 because nobody can check one (#198).
  return {
    stored: LIST_OPS.has(op) ? resolved.map((r) => r.id) : resolved[0].id,
    matched: [],
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

  // A field a condition can never match on, refused before anything else
  // (#185). The engine saves such a rule and then answers it `undefined` for
  // ever, so it reads correctly and never fires.
  if (!MATCHABLE_FIELDS.has(condition_field)) {
    throw new Error(refuseMatchingField(condition_field));
  }

  // And a field the rule cannot write (#187). The engine takes the action,
  // and what it costs lands on whoever next imports a transaction that
  // matches it, which may be weeks later and is not traceable back to here.
  if (!SETTABLE_FIELDS.has(action_field)) {
    throw new Error(refuseSettingField(action_field));
  }

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

  const action = await resolveRuleValue(action_field, 'is', action_value, 'action');
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

  // Written out by the same describer `get_rules` and `delete_rule` use, so
  // the three cannot drift apart again (#198). It read the request back, with
  // quotes round everything: a figure stored as a number came back as
  // `set amount = "-6.60"` and a stored boolean as `set cleared = "false"`,
  // which since 0.10.6 is how the listing writes the broken form of the same
  // rule. The reply to the call that made a working one read like the one
  // that takes an import down.
  //
  // Described from the rule that was sent, which is what the engine stored:
  // `createRule` saves it as given, and reading it back would mean loading
  // every rule in the budget to find this one.
  // The rule is already created by now, so a failure here must not become an
  // error: the caller reads "Error", tries again, and the budget ends up with
  // the rule twice. It degrades to ids, the way `delete_rule` does.
  let names: RuleNames = {
    byId: new Map(),
    schedules: new Map(),
    qualified: new Map(),
    known: false,
  };
  let namesFailed = false;
  try {
    names = await loadRuleNames();
  } catch {
    namesFailed = true;
  }
  const described = describeRule(rule, names);

  return [
    'Rule created:',
    ...described.conditions,
    ...described.actions,
    ...matched,
    ...(namesFailed && described.usesIds
      ? [
          '  The names behind these ids could not be read just now, so the ids are shown',
          '  as they are stored. The rule is created.',
        ]
      : []),
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
            'notes, date, imported_payee, cleared, reconciled',
        ),
      condition_op: z
        .string()
        .describe(
          'Operator: is, isNot, oneOf, notOneOf, contains, doesNotContain, matches, gt, lt, ' +
            'gte, lte. oneOf and notOneOf take a list. contains, doesNotContain and matches ' +
            'are refused on payee, category, category_group and account, which Actual stores ' +
            'as ids: they would compare against the id. For text on a payee, imported_payee ' +
            'holds what the row arrived with, and payee_name the payee name, once that payee ' +
            'exists. On amount the operators are is, isapprox, gt, gte, lt and lte; ' +
            'isNot is not one of them. On cleared and reconciled the only operator is ' +
            'is: for "not cleared", write cleared is false.',
        ),
      condition_value: z
        .union([RULE_VALUE, z.array(RULE_VALUE)])
        .describe(
          'Value to match against. For payee, category, category_group and account, a whole ' +
            'name or an ID. For amount, the figure as you would say it (45.50, or -45.50 for ' +
            'money going out), not in cents. Spending is negative, so "more than 45.50 spent" ' +
            'is lt -45.50: gt -45.50 would also catch every deposit and every zero. For ' +
            'cleared and reconciled, true or false; yes and 1 are read as true, no and 0 ' +
            'as false. Pass a list for oneOf and notOneOf; a single value for every ' +
            'other operator.',
        ),
      action_field: z
        .string()
        .describe(
          'Field to set: category, payee, payee_name, notes, account, amount, date, ' +
            'imported_payee, cleared, reconciled. Not category_group, which does nothing, ' +
            'and not transfer, parent or saved, which make every import that matches the ' +
            'rule fail as a whole. Setting account moves a transaction that arrives ' +
            'through a file import or a bank sync, and one you apply the rule to by hand, ' +
            'but not one recorded through this server, which keeps the account it was ' +
            'given. A later import of the same movement does not recognise the moved row, ' +
            'so a bank sync can leave a duplicate; a row moved off budget also loses its ' +
            'category.',
        ),
      action_value: RULE_VALUE.describe(
        'Value to set (category name/ID, payee name/ID, account name/ID, note text, an ' +
          'amount as you would say it, or true or false for cleared and reconciled). A ' +
          'payee, category or account must already exist; use create_payee or ' +
          'create_category for a new one.',
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
