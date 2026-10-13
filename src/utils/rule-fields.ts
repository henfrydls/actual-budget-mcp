/**
 * Which rule fields the engine stores by id, and which operators lie on them.
 *
 * A rule condition on one of these holds an id, and the engine compares the
 * text operators against that id rather than against the name. So
 * `payee contains "Netfl"` never matches Netflix, and `payee contains "-"`
 * matches nearly everything, since a UUID is mostly hyphens. Nothing reports
 * an error: the rule is created and listed like any other, and it quietly
 * recategorises transactions that have nothing to do with what was asked for.
 *
 * Measured on a fresh budget, with one transaction categorised as "Fun",
 * which is in the "Spending" group:
 *
 *   category contains "Fun"                    does not fire
 *   category contains <start of its id>        fires
 *   category doesNotContain "Fun"              fires
 *   category_group doesNotContain "Spending"   fires
 *
 * The lines with `doesNotContain` are the same fact from the other side, and
 * they are the ones that do damage unnoticed: a rule written to exclude a
 * category applies to every transaction in it.
 */

/**
 * Rule fields whose value is an id, so text operators compare against a UUID.
 *
 * Taken from the engine's own `FIELD_INFO`, which is not exported, so it is
 * written out here and checked against the installed copy by a test. That
 * check is the point: `category_group` was missed when this list was written
 * from the three fields the issue happened to name, and the next field the
 * engine adds would be missed the same way.
 */
export const ID_FIELDS = new Set(['payee', 'category', 'category_group', 'account']);

/** Operators that compare text, and therefore cannot work on an id field. */
export const TEXT_OPS = new Set(['contains', 'doesNotContain', 'matches']);

export function isTextOpOnIdField(field: string, op: string): boolean {
  return ID_FIELDS.has(field) && TEXT_OPS.has(op);
}

/**
 * What works instead, per field, and only what works **today**.
 *
 * Measured, because the obvious advice was wrong twice before it was right.
 * `oneOf` used to fail outright from here, since the engine wants an array and
 * a single string went out, and `is` with a name only worked where the name
 * was resolved before saving. Both are fixed (#170, #171), so a name works on
 * all four fields and `oneOf` takes a list of them.
 *
 * Matching a payee as text is awkward, and neither field covers every case.
 * The engine fills `payee_name` in only when the transaction's payee is one
 * that already exists: a payee that does not exist yet is created **after**
 * the rules run. Measured, with a rule `payee_name contains "Netfl"`:
 *
 *   a row whose payee "Netflix" already exists   fires
 *   a row under a name not seen before           does not fire
 *
 * So the first charge from a shop, under whatever name the bank writes, is
 * exactly the one a text rule on the name misses. `imported_payee` holds the
 * text the row arrived with instead, which is the bank's wording on an
 * imported row and whatever was typed on one created here, and measured both
 * ways it does fire on that first charge.
 *
 * Both are named, and neither is offered as the one that always works,
 * because an earlier version of this said `payee_name` worked "whether the
 * transaction came from your bank or was entered here" and that is false in
 * the case someone writing a rule cares most about.
 */
function alternativeFor(field: string): string {
  switch (field) {
    case 'payee':
      return (
        'To match the payee itself, use `is`, or `oneOf` with a list, and a payee name. For ' +
        'text, the two fields ' +
        'are `imported_payee`, which holds the text the row arrived with, from your bank or ' +
        'from whoever created it here, and `payee_name`, which compares against the payee\'s ' +
        'current name but only once that payee exists, so `imported_payee` is the one that ' +
        'catches the first charge under a name you have not seen before.'
      );
    default:
      // Every one of these resolves a whole name to an id now (#170), so the
      // name works in all four, and `oneOf` takes a list of them (#171).
      return `Use \`is\`, or \`oneOf\` with a list, and a ${field.replace('_', ' ')} name.`;
  }
}

/**
 * What to tell someone who asked for one, in the tool that would create it.
 *
 * It names the way out rather than only the refusal.
 */
export function refuseTextOpOnIdField(field: string, op: string): string {
  return (
    `A rule cannot use \`${op}\` on \`${field}\`. Actual stores that field as an id, and ` +
    `compares \`${op}\` against the id rather than the name, so the rule would match ` +
    `transactions that have nothing to do with what you meant, and miss the ones you ` +
    `wanted. ${alternativeFor(field)}`
  );
}

/**
 * The same thing, for a rule that already exists.
 *
 * Rules created before this was refused are still in the budget and still
 * firing. They cannot be found by reading them: the condition looks ordinary,
 * and in the Actual app it looks right as well, because the rule editor's
 * preview compares against the name even though the rule itself does not.
 */
export function warnTextOpOnIdField(field: string, op: string): string {
  return (
    `\`${op}\` on \`${field}\` compares against the internal id, not the name, so this rule ` +
    `may be firing on transactions it has nothing to do with. Actual's own filters compare ` +
    `by name, so the rule may look right where you wrote it. ${alternativeFor(field)}`
  );
}

/**
 * The fields the engine accepts a list on, for `oneOf` and `notOneOf`.
 *
 * Measured against the engine, one rule per field: the four id fields plus
 * the two string fields that are not `notes`. Everything else answers with a
 * bare "Failed creating a new rule", which tells the caller nothing about
 * which part of their rule was wrong.
 *
 * `FIELD_INFO` agrees and says why: `notes` carries `disallowedOps` with
 * `oneOf` and `notOneOf` in it, and the date, number and boolean types do not
 * list those operators at all. The list is checked against the engine's own
 * by the same test that checks the id fields.
 */
export const LIST_FIELDS = new Set([
  'payee',
  'category',
  'category_group',
  'account',
  'payee_name',
  'imported_payee',
]);

/**
 * The operators the engine takes on a numeric field.
 *
 * Measured, one rule per operator, on `amount`: `is`, `isapprox`, `gt`,
 * `gte`, `lt` and `lte` are accepted, and `isNot`, `contains` and `oneOf` come
 * back as `Invalid condition operator`, which reaches the caller as a bare
 * "Failed creating a new rule". So advice that offers `isNot` on an amount
 * sends someone into exactly the message this is meant to replace.
 *
 * `isbetween` is accepted by the engine too, and is left out because it takes
 * two figures in one value and this server has no way to write that yet.
 */
export const AMOUNT_OPS: ReadonlySet<string> = new Set([
  'is',
  'isapprox',
  'gt',
  'gte',
  'lt',
  'lte',
]);

/**
 * The fields Actual stores as a number, which is where an amount lives.
 *
 * One field today, and it is money, which both of its uses depend on: a value
 * read from one is formatted as money rather than printed as the integer the
 * engine keeps (#182), and a value written to one is converted from the
 * figure someone typed (#183). `FIELD_INFO` is not exported, so the list is
 * written out by hand like `ID_FIELDS`, and the same test holds it to the
 * installed engine: a later version with a numeric field that is not money
 * would otherwise be formatted as currency, and parsed as an amount, without
 * anyone noticing.
 */
export const NUMBER_FIELDS: ReadonlySet<string> = new Set(['amount']);

/**
 * The fields Actual stores as true or false.
 *
 * Four of them, and the issue that reported this named two. Taken from the
 * engine's `FIELD_INFO` rather than from the fields an issue happened to
 * mention, which is how `category_group` was missed from the id list, and
 * held to the installed engine by a test.
 *
 * Being on this list is what decides that a value has to be read as a boolean
 * before it is saved. It is not the same question as whether a rule can use
 * the field at all: two of these four cannot be used for anything, and
 * `MATCHABLE_FIELDS` and `SETTABLE_FIELDS` below are what answer that.
 */
export const BOOLEAN_FIELDS: ReadonlySet<string> = new Set([
  'cleared',
  'reconciled',
  'transfer',
  'parent',
]);

/**
 * The operators the engine takes on a boolean field: one.
 *
 * `TYPE_INFO` gives the boolean type a single operator, and measured one rule
 * at a time on `cleared`, `isNot`, `oneOf`, `contains`, `gt` and `isapprox`
 * each come back as a bare "Failed creating a new rule". There is no `isNot`
 * here, which matters because it is the obvious way to write "not cleared":
 * the way that works is `cleared is false`.
 */
export const BOOLEAN_OPS: ReadonlySet<string> = new Set(['is']);

/**
 * Every field the engine's rule table knows about.
 *
 * Which is not the same as every field a rule can use: three of these can
 * never be matched on and four can never be set. Written out from
 * `FIELD_INFO`, which is not exported, and held to the installed engine by a
 * test, so that a field added in a later version is noticed here rather than
 * falling through as "Actual has never heard of it".
 */
export const RULE_FIELDS: ReadonlySet<string> = new Set([
  'account',
  'amount',
  'category',
  'category_group',
  'cleared',
  'date',
  'imported_payee',
  'notes',
  'parent',
  'payee',
  'payee_name',
  'reconciled',
  'saved',
  'transfer',
]);

/**
 * The fields a condition can actually match on.
 *
 * A rule condition is evaluated against one object, and the engine's
 * `Condition.eval` reads `object[field]` and returns false the moment that is
 * `undefined`. So a field the object never carries does not error: the rule is
 * created, it reads perfectly well, and it never fires. That is the same shape
 * as the rules #167 and #170 left behind.
 *
 * The object is a transaction row plus what `prepareTransactionForRules` adds
 * to it, which is `payee_name` and `category_group` and nothing else. Three
 * fields in `FIELD_INFO` are therefore unreachable: `transfer`, `parent` and
 * `saved`. A transaction row has `transfer_id` and `is_parent`, under those
 * names, and nothing ever copies them across.
 *
 * Measured, not only read: a rule `transfer is true` with an action on the
 * notes, against a transaction imported with an account payee, which the
 * engine turns into a real transfer. The row came out with its `transfer_id`
 * set and its notes untouched, in all three stages, on first import and on
 * re-import of a row that was already a transfer. The same for `parent`
 * against a split.
 */
export const MATCHABLE_FIELDS: ReadonlySet<string> = new Set([
  'account',
  'amount',
  'category',
  'category_group',
  'cleared',
  'date',
  'imported_payee',
  'notes',
  'payee',
  'payee_name',
  'reconciled',
]);

/**
 * What to say when a condition names a field it can never match on.
 *
 * Refused rather than created, because a rule that never fires is worse than
 * an error: it is saved, it reads like it works, and the transactions it was
 * written for go on being untouched with nobody looking for a reason.
 */
export function refuseMatchingField(field: string): string {
  // A field the engine has never heard of is refused by the engine too, with
  // its own bare message. Saying "it would never fire" about it would be
  // false, and would send someone looking for a rule that was never saved.
  if (!RULE_FIELDS.has(field)) {
    return (
      `Actual has no rule field called \`${field}\`. A condition can match on ` +
      `${[...MATCHABLE_FIELDS].join(', ')}.`
    );
  }
  // What the field was for, said back, because the refusal is where somebody
  // finds out that the thing they wanted to match on is not available.
  const asked = BOOLEAN_FIELDS.has(field)
    ? `, which asks whether a transaction is ${describeBooleanField(field)}`
    : '';
  // The name is the whole of it, and the first version of this said it was a
  // matter of timing. It is not: a transaction that already had its
  // `transfer_id` does not match either. What the rules are handed carries
  // `transfer_id` and `is_parent`, under those names, and never `transfer` or
  // `parent`.
  const because =
    field === 'transfer' || field === 'parent'
      ? `A transaction carries this as \`${field === 'transfer' ? 'transfer_id' : 'is_parent'}\`, ` +
        `and nothing ever copies it across under the name a rule uses. `
      : '';
  return (
    `A rule cannot match on \`${field}\`${asked}. ${because}The engine checks a condition ` +
    `by looking the field up on the transaction it was handed, and it is never there, so ` +
    `Actual never runs the rule on its own: not on import, not on a bank sync, not when a ` +
    `transaction is added or changed. It would still match if you applied it by hand from ` +
    `the rules page, where the conditions become a query instead. A condition that runs on ` +
    `its own can match on ${[...MATCHABLE_FIELDS].join(', ')}.`
  );
}

/**
 * What each boolean field says about a transaction, in words.
 *
 * A rule is stored and keeps running, so the reply is the one chance the
 * writer gets to see what they asked for. `cleared is false` reads well enough
 * on its own, and the words are what make the reply say it rather than repeat
 * the field name back.
 *
 * Every field in `BOOLEAN_FIELDS` has an entry here and a test holds it to
 * that, because a field without one is said back as "undefined" in the one
 * sentence that exists to be read.
 */
const BOOLEAN_MEANING: Record<string, string> = {
  cleared: 'cleared',
  reconciled: 'reconciled',
  transfer: 'part of a transfer',
  parent: 'a split parent',
};

/** The words for one of those fields, for a reply or for a refusal. */
export function describeBooleanField(field: string): string {
  return BOOLEAN_MEANING[field];
}

export function refuseListOnField(field: string, op: string): string {
  // `isNot` is in the general advice and the engine takes it on neither a
  // figure nor a truth, so both kinds need their own way out. A boolean has
  // nothing to match several of either: the field has two values, and a list
  // of both of them matches every transaction there is.
  const alternatives = NUMBER_FIELDS.has(field)
    ? `Use ${[...AMOUNT_OPS].map((o) => `\`${o}\``).join(', ')} for one figure, or one of ` +
      `those fields to match several.`
    : BOOLEAN_FIELDS.has(field)
      ? 'Use `is` with true or false.'
      : 'Use `is` or `isNot` for one value, or one of those fields to match several.';
  return (
    `A rule cannot use \`${op}\` on \`${field}\`. Actual takes a list only on ` +
    `${[...LIST_FIELDS].join(', ')}. ${alternatives}`
  );
}

/**
 * What to say when a value arrives as a list on a field that takes one value.
 *
 * The general answer is to use `oneOf`, and on a field that does not take a
 * list that is the same broken promise as sending someone to `isNot`: the
 * operator named is one the engine refuses here too.
 */
export function refuseListValue(field: string, op: string): string {
  const instead = LIST_FIELDS.has(field)
    ? 'Use `oneOf` or `notOneOf` to match several, or send a single value.'
    : BOOLEAN_FIELDS.has(field)
      ? `Send one value. \`${field}\` is true or false, and a list of both matches every ` +
        `transaction there is.`
      : `Send one value. Actual takes a list only on ${[...LIST_FIELDS].join(', ')}.`;
  return `\`${op}\` takes one value, not a list. ${instead}`;
}

/** What to say when an operator is not the one a boolean field takes. */
export function refuseOpOnBoolean(field: string, op: string): string {
  // `isNot` is the one worth answering, because it is how anyone would write
  // "not cleared" and it is what this tool's own advice used to offer. After
  // `contains` or `gt` the same sentence would be a non sequitur.
  const instead =
    op === 'isNot'
      ? ` To match a transaction that is not ${describeBooleanField(field)}, use \`is\` ` +
        `with false.`
      : '';
  return (
    `A rule cannot use \`${op}\` on \`${field}\`, which is true or false. Actual takes ` +
    `\`is\` there and nothing else.${instead}`
  );
}

/** What to say when an operator is not one a numeric field takes. */
export function refuseOpOnAmount(field: string, op: string): string {
  // The advice about matching what you do want answers `isNot` and nothing
  // else: it reads as a non sequitur after `contains` or `isbetween`, which
  // are refused here for entirely different reasons.
  const instead =
    op === 'isNot' ? ' For "not this amount", match the amounts you do want instead.' : '';
  return (
    `A rule cannot use \`${op}\` on \`${field}\`, which holds a figure. Actual takes ` +
    `${[...AMOUNT_OPS].map((o) => `\`${o}\``).join(', ')} there.${instead}`
  );
}

/**
 * Whether a stored rule value is a name where the engine wanted an id.
 *
 * This is what a rule left behind by #167 and #170 looks like: the condition
 * reads perfectly well, and the rule has never matched anything. Told apart
 * from a deleted thing by the shape: an id that resolves to nothing was
 * something once, a value that is not an id shape never was.
 */
export function looksLikeAnId(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value.trim());
}

