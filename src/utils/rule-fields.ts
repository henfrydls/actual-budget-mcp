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

export function refuseListOnField(field: string, op: string): string {
  return (
    `A rule cannot use \`${op}\` on \`${field}\`. Actual takes a list only on ` +
    `${[...LIST_FIELDS].join(', ')}. Use \`is\` or \`isNot\` for one value, or one of ` +
    `those fields to match several.`
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

/**
 * The fields Actual stores as a number, which is where an amount lives.
 *
 * One field today, and it is money, so a value on it is formatted as money
 * rather than printed as the integer the engine keeps. Written out by hand
 * for the same reason as `ID_FIELDS`, `FIELD_INFO` is not exported, and
 * checked against the installed engine by the same test: a later version with
 * a numeric field that is not money would otherwise be formatted as currency
 * without anyone noticing.
 */
export const NUMBER_FIELDS: ReadonlySet<string> = new Set(['amount']);
