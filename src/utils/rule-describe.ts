import * as api from '@actual-app/api';
import {
  BOOLEAN_FIELDS,
  ID_FIELDS,
  MATCHABLE_FIELDS,
  NUMBER_FIELDS,
  SETTABLE_FIELDS,
  isTextOpOnIdField,
  warnTextOpOnIdField,
  looksLikeAnId,
} from './rule-fields.js';
import { describeRecurrence } from './schedule-recurrence.js';
import { formatMoney } from './money.js';

/**
 * How a rule reads, in one place, for every tool that has to show one.
 *
 * This was written inside `get_rules` and stayed there, so `delete_rule`
 * printed the same rule through `JSON.stringify`: an amount a hundred times
 * larger than the figure it means, a recurrence as its stored config, and a
 * payee as a uuid (#186). The one reply someone says yes to before a rule is
 * gone was the one that could not be read.
 */

/** The names behind the ids a rule stores. */
export interface RuleNames {
  /** Category, category group, payee and account ids. */
  byId: Map<string, string>;
  /** Schedule ids, which only `link-schedule` carries. */
  schedules: Map<string, string>;
  /**
   * Whether these are the budget's names or a stand-in for names that could
   * not be read.
   *
   * It decides whether an id this cannot resolve is a broken rule or an
   * unanswered question. With an empty map and no way to tell them apart,
   * every id in a healthy rule was marked as pointing at something that is no
   * longer in the budget, and that is the sentence someone reads while
   * deciding whether to delete the rule.
   */
  known: boolean;
}

/**
 * Read the names a rule's ids stand for.
 *
 * Every field the engine stores by id, not two of them. A rule listing raw
 * UUIDs cannot be checked by the person who asked for it, which is the whole
 * job of showing one.
 */
export async function loadRuleNames(): Promise<RuleNames> {
  const categories = await api.getCategories();
  const groups = await api.getCategoryGroups();
  const payees = await api.getPayees();
  const accounts = await api.getAccounts();
  const byId = new Map<string, string>([
    ...categories.filter((c) => 'group_id' in c).map((c) => [c.id, c.name] as const),
    ...groups.map((g) => [g.id, g.name] as const),
    ...payees.map((p) => [p.id, p.name] as const),
    ...accounts.map((a) => [a.id, a.name] as const),
  ]);

  // A rule Actual writes for a schedule ends in `link-schedule` holding the
  // schedule's id, and the id is the one thing the person reading the list
  // cannot look up anywhere (#182).
  const schedules = new Map<string, string>();
  try {
    const found = (await api.getSchedules()) as { id?: unknown; name?: unknown }[];
    for (const schedule of found ?? []) {
      if (typeof schedule.id === 'string' && typeof schedule.name === 'string') {
        schedules.set(schedule.id, schedule.name);
      }
    }
  } catch {
    // The rules are the answer; the schedule names are an improvement on one
    // line of it. A listing that loses them is still worth printing, and a
    // budget with no schedules reaches here with nothing to lose.
  }

  return { byId, schedules, known: true };
}

/**
 * A stored value, as the person who wrote the rule would recognise it.
 *
 * Quotes mean one thing: this is the text the budget is holding, printed back
 * as it is. Everything that stands for something else goes without them: a
 * figure, a true or false, a recurrence in words, the name an id resolves to,
 * and the two words for a value that is not there.
 *
 * That is the whole point of the rule rather than a matter of taste. `"-5.55"`
 * beside `-5.55` is a rule that takes the next import down beside one that
 * works (#183), `"false"` beside `false` is a rule that means the opposite of
 * what it says (#185), and `"Netflix"` beside `Netflix` is a payee that was
 * never saved as one beside a payee that was. The quotes used to go round
 * everything, so each pair printed the same way and only the warning
 * underneath told them apart.
 *
 * The text is escaped, so a note holding a quote cannot be read as two
 * values: `a", "b` and the list of `a` and `b` printed identically.
 *
 * Lists as well as single values: `oneOf` holds an array, and printing it raw
 * was a row of UUIDs separated by commas.
 */
export function readable(names: RuleNames, field: string, value: unknown): string {
  const one = (v: unknown): string => {
    // Nothing, said as nothing. `category is null` is a real rule that
    // matches transactions with no category, and printing it as the word
    // "null" reads like a value someone typed by mistake. Not quoted: it
    // stands for the absence of a value rather than for one.
    //
    // The empty string is not that. It is text, and it is the stored value of
    // two broken rules: `set amount = ""` takes the next import down and
    // `set cleared = ""` means false. Printing it as `(none)` put it on the
    // same line as `null`, which on `amount` sets every matching transaction
    // to zero instead, and only the warning underneath said which was which.
    if (v === null || v === undefined) return '(none)';

    // An amount is stored the way every amount is stored, as an integer in
    // the smallest unit, and it was printed raw: a rule on a rent of 4,500
    // read `IF amount is "-450000"`. The engine's own field table has exactly
    // one numeric field, and a test holds that list to it.
    if (NUMBER_FIELDS.has(field)) {
      if (typeof v === 'number') return formatMoney(v);
      // `isbetween` holds the two bounds in one value.
      const range = v as { num1?: unknown; num2?: unknown };
      if (typeof range?.num1 === 'number' && typeof range?.num2 === 'number') {
        return `${formatMoney(range.num1)} and ${formatMoney(range.num2)}`;
      }
    }

    if (typeof v === 'boolean') return v ? 'true' : 'false';
    if (typeof v === 'number') return String(v);

    // The date of a schedule is a recurrence, and `String()` on it gives
    // `[object Object]`. A plain date is a string and comes back undefined
    // here, which sends it on to be quoted as the text it is.
    const recurrence = describeRecurrence(v);
    if (recurrence !== undefined) return recurrence;

    // Whatever is left that is an object, written out rather than
    // stringified: `String({})` is `[object Object]`, which is what this was
    // reported for. A recurrence it will not describe, because one part of it
    // means nothing to it, lands here, and the stored config is at least
    // true.
    if (typeof v === 'object') return JSON.stringify(v);

    const text = String(v);
    // An id the budget answers to is printed as the thing it names, without
    // quotes, because the name stands for something rather than being the
    // stored text. One it does not answer to is the stored text and nothing
    // more, which is exactly what #167 and #170 left behind: a rule holding
    // the name where the id belongs, reading perfectly well and never
    // matching anything. The quotes are what tell the two apart on the line
    // itself.
    const named = ID_FIELDS.has(field) ? names.byId.get(text) : undefined;
    if (named !== undefined) return confusable(named) ? JSON.stringify(named) : named;
    // `JSON.stringify` rather than a pair of quotes, so a value holding one
    // is escaped instead of closing the pair early.
    return JSON.stringify(text);
  };
  if (Array.isArray(value)) {
    return value.length === 0 ? '(empty list)' : value.map(one).join(', ');
  }
  return one(value);
}

/**
 * Whether a name would read as one of the other things this listing prints.
 *
 * A name goes without quotes, which is what tells a payee apart from a rule
 * holding the text of one. A payee called `true`, `123` or `(none)` would
 * then read as a boolean, a figure or an absent value, and one whose name
 * begins with a quote would read as the broken kind. Those few get the quotes
 * and the escaping back, which is the smaller surprise: a name that needs
 * them is already unusual.
 *
 * The list is the forms this listing uses for something other than text, so
 * it is enumerable rather than a guess. What it does not cover is a name
 * holding the separator a list uses, since every separator can appear in a
 * name and bracketing every value costs more than the case is worth.
 *
 * A figure is the whole name and nothing else, which is why the test is
 * anchored: `Super 24` is a payee, not an amount, and quoting it would say it
 * is the text of something rather than the name of somebody.
 */
function confusable(name: string): boolean {
  return (
    name === '(none)' ||
    name === '(empty list)' ||
    name === 'true' ||
    name === 'false' ||
    // The forms a value that is not text comes back in: a quoted string, and
    // the stored config of an object or a list, which is written out as JSON
    // when there is nothing better to say about it.
    name.startsWith('"') ||
    name.startsWith('{') ||
    name.startsWith('[') ||
    /^-?[\d,]*\d(\.\d+)?$/.test(name)
  );
}

/**
 * Whether an id field is holding something that is not an id of anything,
 * which is what a rule left behind by #167 and #170 looks like: it reads
 * perfectly well and has never matched a transaction.
 *
 * A name and a deleted thing are told apart by the shape, because the advice
 * differs: one was never pointing anywhere, the other was.
 */
function brokenValues(names: RuleNames, field: string, value: unknown): string[] {
  if (!ID_FIELDS.has(field)) return [];
  // Nothing is known to be broken when nothing is known. Marking every id as
  // missing because the lookup failed accuses healthy rules of the one fault
  // whose advice is to delete them.
  if (!names.known) return [];
  const list = Array.isArray(value) ? value : [value];
  return (
    list
      // Nothing is not a broken id. `category is null` matches transactions
      // with no category and fires: measured, a row imported without one
      // comes back marked by exactly that rule. Calling it broken invites
      // deleting a rule that works and that `create_rule` cannot write back.
      .filter((v) => v !== null && v !== undefined && v !== '')
      .map((v) => String(v))
      .filter((text) => !names.byId.has(text))
  );
}

/**
 * Whether the value is written somewhere else, in a template or a formula,
 * which is what the app's own rule editor writes.
 */
function hasOwnTemplate(options: unknown): boolean {
  const o = options as { template?: unknown; formula?: unknown } | null | undefined;
  return Boolean(o && (o.template || o.formula));
}

/** An empty list matches nothing, whatever the field. */
function isEmptyList(value: unknown): boolean {
  return Array.isArray(value) && value.length === 0;
}

/**
 * An action on a figure holding the text of one (#183, #185).
 *
 * The same shape as the boolean below and the worst of the three this marks.
 * Measured: the next import with a transaction matching the rule dies on
 * `Can't convert to integer: "-555"` and brings in none of its batch, so a
 * bank sync stops working. The engine does not check an action's value, so
 * this is what every rule written before the conversion looks like, and
 * nothing in the listing told them apart: a figure and the text of one both
 * printed as money.
 */
function textWhereActionFigureBelongs(
  field: string,
  value: unknown,
  options: unknown,
): string | null {
  if (!NUMBER_FIELDS.has(field) || typeof value !== 'string') return null;
  if (hasOwnTemplate(options)) return null;
  return (
    `warning: this holds the text "${value}" where Actual keeps a figure, so every ` +
    `import with a transaction matching this rule fails with ` +
    `\`Can't convert to integer\` and none of the batch arrives. Recreate the rule ` +
    `with create_rule.`
  );
}

/**
 * An action on a figure holding nothing at all (#183).
 *
 * Not the same fault as the text of a figure, and not the same cost.
 * Measured, with a rule `set amount = null` and a batch of two: the import
 * goes through, the neighbour arrives, and the matching row lands at 0. Money
 * quietly set to nothing, on every import, with the listing showing
 * `set amount = (none)`.
 *
 * An action saved with no value key at all behaves the same way, so both are
 * read as nothing rather than only `null`.
 */
function nothingWhereActionFigureBelongs(
  field: string,
  value: unknown,
  options: unknown,
): string | null {
  if (!NUMBER_FIELDS.has(field) || value !== null) return null;
  if (hasOwnTemplate(options)) return null;
  return (
    `warning: this holds nothing where Actual keeps a figure, so it sets every ` +
    `transaction it matches to zero. The import goes through, which is what makes ` +
    `it hard to notice. Recreate the rule with create_rule.`
  );
}

/**
 * An action on a boolean field holding the word instead of the value (#185).
 *
 * The engine checks a condition's value and does not check an action's, so
 * this is what the rules written before `create_rule` converted look like,
 * and they are the dangerous half. Measured, on rows imported uncleared: an
 * action holding "true", "false" or "banana" all left the row cleared,
 * because anything that is not empty is true. A rule written to mark
 * transactions as not cleared does the opposite, on every import.
 */
function wordWhereActionBooleanBelongs(
  field: string,
  value: unknown,
  options: unknown,
): { kind: string; text: string } | null {
  if (!BOOLEAN_FIELDS.has(field) || typeof value !== 'string') return null;
  // A template or a formula is where the value comes from, and the engine
  // does not read the stored one at all: `Action.exec` falls through to it
  // only when there is neither. Measured, a template of `true` on `cleared`
  // sets the flag with an empty value saved beside it. Marking those is
  // marking a rule made in the app, which is how people learn to ignore the
  // marks.
  if (hasOwnTemplate(options)) return null;
  // Two cases, and they mean opposite things: an empty value is read as false
  // and a word as true. One line of the listing cannot say both, and neither
  // can the paragraph that closes it.
  if (value === '') {
    return {
      kind: 'empty-boolean',
      text:
        `warning: this holds an empty value where Actual keeps true or false, so it ` +
        `marks every transaction it matches as not ${field}. That is what an empty ` +
        `value happens to mean here, rather than what anyone wrote. Recreate the ` +
        `rule with create_rule.`,
    };
  }
  return {
    kind: 'opposite',
    text:
      `warning: this holds the word "${value}", not the value true or false, and ` +
      `Actual reads anything that is not empty as true. So it means true here, ` +
      `whatever the word says. Recreate the rule with create_rule.`,
  };
}

function describeBroken(names: RuleNames, field: string, bad: string[]): string {
  const asNames = bad.filter((v) => !looksLikeAnId(v));
  if (asNames.length > 0) {
    return (
      `warning: this stores ${asNames.map((v) => `"${v}"`).join(', ')} where Actual ` +
      `expects ${field === 'account' ? 'an' : 'a'} ${field.replace('_', ' ')} id, so ` +
      `it never fires. Recreate the rule with create_rule, which resolves the name.`
    );
  }
  // An id that is right but for its case. Measured: the engine compares ids
  // exactly, so the rule really does not fire, and saying "no longer exists"
  // would send someone looking for something that is sitting there.
  const wrongCase = bad.filter((v) => names.byId.has(v.toLowerCase()));
  if (wrongCase.length > 0) {
    return (
      `warning: this id is written in a different case from the one in your budget ` +
      `(${wrongCase.map((v) => names.byId.get(v.toLowerCase())).join(', ')}), and the ` +
      `engine compares ids exactly, so it never fires. Recreate the rule.`
    );
  }
  if (field === 'account') {
    // A closed account is unreachable from the API: measured, it is returned
    // by neither `getAccounts()`, with or without options, nor a query,
    // filtered on `closed` or not. So this cannot tell a closed account from
    // a deleted one, and must not advise deleting a rule whose account the
    // person could simply reopen.
    return (
      `warning: this points at an account that is not in the budget. It may have been ` +
      `deleted, or closed, which hides it from everything here. Reopen the account if ` +
      `that is it, or recreate the rule.`
    );
  }
  return (
    `warning: this points at ${bad.length === 1 ? 'an id' : 'ids'} that ` +
    `${bad.length === 1 ? 'is' : 'are'} no longer in the budget, so it never fires. ` +
    `Recreate the rule or delete it.`
  );
}

/**
 * A split action, which carries no field and whose value means three
 * different things.
 *
 * Read from the engine: `fixed-percent` takes that percentage of what is left
 * after the fixed amounts, `remainder` divides what is left between the
 * actions that ask for it, and anything else sets the amount outright, in the
 * smallest unit like every other amount. The index is printed as it is
 * stored, without being renumbered into something that reads like a position
 * the app would show.
 */
function describeSplitAmount(
  names: RuleNames,
  action: { value?: unknown; options?: unknown },
): string {
  const options = action.options as { method?: unknown; splitIndex?: unknown } | undefined;
  const part = typeof options?.splitIndex === 'number' ? ` (split ${options.splitIndex})` : '';
  if (options?.method === 'remainder') return `set-split-amount = what is left${part}`;
  if (options?.method === 'fixed-percent') {
    // Through `readable` like every other value, with a field that is in no
    // set, so a percentage written as text keeps its quotes and nothing is
    // read as money. This was the one value printed with `String()`, which
    // showed `null` as the word and the text of a figure as a figure.
    return `set-split-amount = ${readable(names, 'set-split-amount', action.value)}% of what is left${part}`;
  }
  return `set-split-amount = ${readable(names, 'amount', action.value)}${part}`;
}

/** One rule, written out, with whatever is wrong with it said beside it. */
export interface DescribedRule {
  /** The `IF` lines, each followed by its warning when it has one. */
  conditions: string[];
  /** The `THEN` lines, the same way. */
  actions: string[];
  stage: string;
  conditionsOp: string;
  /** How many lines carry a warning. */
  flagged: number;
  /** Whether anything in the rule is stored as an id, and so needs a name. */
  usesIds: boolean;
  /** Which kinds of warning were given, for whatever closes the reply. */
  kinds: Set<string>;
}

/**
 * Write one rule out: its conditions, its actions, and what is wrong with
 * them.
 *
 * Rules created before `create_rule` refused these are still here and still
 * firing (#169). Nothing in a listing shows what is wrong with them: the
 * condition reads like any other, and the damage is that it is compared
 * against an id.
 */
export function describeRule(rule: unknown, names: RuleNames): DescribedRule {
  const detail = rule as {
    stage?: string | null;
    conditionsOp?: string;
    conditions?: Array<{ field: string; op: string; value: unknown; options?: unknown }>;
    actions?: Array<{ field?: string; op: string; value?: unknown; options?: unknown }>;
  };
  const conditionLines: string[] = [];
  const actionLines: string[] = [];
  let usesIds = false;
  let flagged = 0;
  const kinds = new Set<string>();
  const mark = (into: string[], kind: string, text: string) => {
    flagged += 1;
    kinds.add(kind);
    into.push(`      ${text}`);
  };

  for (const cond of detail.conditions ?? []) {
    // `inflow` and `outflow` decide which direction the amount is compared
    // in, and the value is stored positive either way: a rule for spending of
    // 4,500 or more is `gte 450000` with `outflow`. Printed without it, and
    // now with the figure formatted as money, it reads as a rule about income
    // (#182).
    if (ID_FIELDS.has(cond.field)) usesIds = true;
    const options = cond.options as { inflow?: unknown; outflow?: unknown } | undefined;
    const flow = options?.outflow ? ' (outflow)' : options?.inflow ? ' (inflow)' : '';
    conditionLines.push(
      `  IF ${cond.field}${flow} ${cond.op} ${readable(names, cond.field, cond.value)}`,
    );
    // One complaint per line. A text operator on an id field holds text on
    // purpose, so the check below would call the same condition broken for a
    // second reason and send the reader looking for two fixes.
    if (isTextOpOnIdField(cond.field, cond.op)) {
      mark(conditionLines, 'wrong-rows', `warning: ${warnTextOpOnIdField(cond.field, cond.op)}`);
      continue;
    }
    if (isEmptyList(cond.value)) {
      mark(
        conditionLines,
        'never-fires',
        'warning: an empty list matches nothing, so this never fires.',
      );
      continue;
    }
    // A field the engine never puts on the transaction it hands the rules
    // (#185). Measured: the condition is answered `undefined` and comes back
    // false every time, so the rule reads correctly and has never fired.
    if (!MATCHABLE_FIELDS.has(cond.field)) {
      mark(
        conditionLines,
        'never-alone',
        `warning: Actual never runs this rule on its own. It looks ${cond.field} up on ` +
          `the transaction and it is not there, so the rule does nothing on import or on ` +
          `a bank sync. It would still match if you applied it by hand from the rules page.`,
      );
      continue;
    }
    // No check here for a word where a boolean belongs. The engine validates
    // a condition's value and refuses a string outright, so a stored boolean
    // condition always holds a real boolean: the checks below are for
    // actions, which the engine does not validate. Condition options are not
    // templates either, they are the inflow and outflow flags on an amount.
    const bad = brokenValues(names, cond.field, cond.value);
    if (bad.length > 0) {
      mark(conditionLines, 'never-fires', describeBroken(names, cond.field, bad));
    }
  }

  for (const action of detail.actions ?? []) {
    // `link-schedule` carries no field, and `field || op` printed the
    // operation twice: `THEN link-schedule link-schedule = "<id>"`. Its value
    // is a schedule, so it is named like one.
    if (!action.field && action.op === 'link-schedule') {
      usesIds = true;
      const id = String(action.value ?? '');
      const named = names.schedules.get(id);
      // The name without quotes, the id with them, for the same reason every
      // other value follows: one stands for a schedule in the budget and the
      // other is the text that is stored.
      actionLines.push(`  THEN link-schedule = ${named ?? JSON.stringify(id)}`);
      continue;
    }
    // A split action carries no field either, and `field || op` printed the
    // operation twice, with the figure in the smallest unit and nothing about
    // which part it is for: `set-split-amount set-split-amount = 5000`.
    if (!action.field && action.op === 'set-split-amount') {
      actionLines.push(`  THEN ${describeSplitAmount(names, action)}`);
      continue;
    }
    const field = action.field || action.op;
    if (ID_FIELDS.has(field)) usesIds = true;
    // A value that comes from a template or a formula is not stored on the
    // action, so the line read `= (none)` and the rule looked broken. The
    // engine reads the template instead, so that is what the rule says.
    const written = action.options as { template?: unknown; formula?: unknown } | undefined;
    // The same truth test `hasOwnTemplate` uses, because the warning below
    // goes by that one: an empty template is not a template, the engine falls
    // through to the stored value, and this said the value came from one.
    const source = written?.template
      ? `the template ${JSON.stringify(String(written.template))}`
      : written?.formula
        ? `the formula ${JSON.stringify(String(written.formula))}`
        : readable(names, field, action.value);
    actionLines.push(`  THEN ${action.op} ${field} = ${source}`);
    if (isEmptyList(action.value)) {
      mark(actionLines, 'nothing', 'warning: an empty list sets nothing.');
      continue;
    }
    // A field the rule cannot write (#187). Worth saying first and on its
    // own: the others make a rule do the wrong thing, and this one makes
    // every import that matches it fail as a whole, which is not traceable
    // back to the rule from anywhere else.
    if (action.op === 'set' && !SETTABLE_FIELDS.has(field)) {
      mark(
        actionLines,
        field === 'category_group' ? 'nothing' : 'import-field',
        field === 'category_group'
          ? `warning: a rule cannot file a transaction under a group, and Actual keeps no ` +
              `column for it, so this action does nothing.`
          : `warning: Actual keeps no ${field} column on a transaction, so every import ` +
              `with a transaction matching this rule fails as a whole and none of the ` +
              `batch arrives. Delete this rule.`,
      );
      continue;
    }
    const actionAsFigure = textWhereActionFigureBelongs(field, action.value, action.options);
    if (actionAsFigure !== null) {
      mark(actionLines, 'import-value', actionAsFigure);
      continue;
    }
    const actionAsNothing = nothingWhereActionFigureBelongs(
      field,
      action.value ?? null,
      action.options,
    );
    if (actionAsNothing !== null) {
      mark(actionLines, 'zero', actionAsNothing);
      continue;
    }
    const actionAsWord = wordWhereActionBooleanBelongs(field, action.value, action.options);
    if (actionAsWord !== null) {
      mark(actionLines, actionAsWord.kind, actionAsWord.text);
      continue;
    }
    const bad = brokenValues(names, field, action.value);
    if (bad.length > 0) {
      mark(actionLines, 'never-fires', describeBroken(names, field, bad));
    }
  }

  return {
    conditions: conditionLines,
    actions: actionLines,
    stage: detail.stage || 'default',
    conditionsOp: detail.conditionsOp || 'and',
    usesIds,
    flagged,
    kinds,
  };
}
