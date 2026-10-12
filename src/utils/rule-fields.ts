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
 * Measured, because the obvious advice was wrong twice. `oneOf` is not offered
 * at all: sending it through this tool fails outright, since the engine wants
 * an array and a single string is what goes out (#171). And `is` with a name
 * is only useful where the name is resolved to an id before the rule is
 * saved, which is payee and category; on `account` and `category_group` the
 * name is stored as typed and the rule never fires (#170). Those two get the
 * id instead, which is what the engine compares against.
 *
 * For matching the payee as text, the field is `payee_name`: the engine fills
 * it in while a transaction is being matched, and measured, a rule on it fires
 * on a row imported from a bank and on a row entered here. `imported_payee`
 * holds the raw text the bank sent, which is a narrower thing and not always
 * what someone means by the payee's name.
 */
function alternativeFor(field: string): string {
  switch (field) {
    case 'payee':
      return (
        'Use `payee_name` with a text operator to match the name, or `is` with a payee name ' +
        'to match the payee itself. `imported_payee` holds the raw text the bank sent, if ' +
        'that is what you want to match.'
      );
    case 'category':
      return 'Use `is` with a category name instead.';
    default:
      // account and category_group: the name is stored as typed and the rule
      // never fires, so the id is the only thing that works today.
      return `Use \`is\` with the ${field} id instead. A name is not resolved for this field yet.`;
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
    `may be firing on transactions it has nothing to do with. The Actual app's rule preview ` +
    `compares names, so it looks correct there. ${alternativeFor(field)}`
  );
}
