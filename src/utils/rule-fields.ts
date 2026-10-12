/**
 * Which rule fields the engine stores by id, and which operators lie on them.
 *
 * A rule condition on `payee`, `category` or `account` holds an id, and the
 * engine compares the text operators against that id rather than against the
 * name. So `payee contains "Netfl"` never matches Netflix, and
 * `payee contains "-"` matches almost everything, since a UUID is mostly
 * hyphens. Nothing reports an error: the rule is created and listed like any
 * other, and it quietly recategorises transactions that have nothing to do
 * with what was asked for.
 *
 * Measured on a fresh budget, with a transaction categorised as "Fun":
 *
 *   category contains "Fun"             does not fire
 *   category contains <start of its id>  fires
 *   category doesNotContain "Fun"        fires
 *
 * The last line is the same fact from the other side, and it is the one that
 * does damage without anyone noticing: a rule written to exclude a category
 * applies to every transaction in it.
 *
 * `imported_payee` holds the text the bank sent and is not an id, so the text
 * operators work there. That is what someone reaching for `payee contains`
 * usually wants.
 */

/** Rule fields whose value is an id, so text operators compare against a UUID. */
export const ID_FIELDS = new Set(['payee', 'category', 'account']);

/** Operators that compare text, and therefore cannot work on an id field. */
export const TEXT_OPS = new Set(['contains', 'doesNotContain', 'matches']);

export function isTextOpOnIdField(field: string, op: string): boolean {
  return ID_FIELDS.has(field) && TEXT_OPS.has(op);
}

/**
 * What to tell someone who asked for one, in the tool that would create it.
 *
 * It names the way out rather than only the refusal: the two things that do
 * work are text matching on what the bank sent, and matching the payee itself
 * by name.
 */
export function refuseTextOpOnIdField(field: string, op: string): string {
  const alternative =
    field === 'payee'
      ? 'Use imported_payee for text matching, which holds what the bank sent, or `is` ' +
        'and `oneOf` with a payee name.'
      : `Use \`is\` or \`oneOf\` with a ${field} name instead.`;
  return (
    `A rule cannot use \`${op}\` on \`${field}\`. Actual stores that field as an id, and ` +
    `compares \`${op}\` against the id rather than the name, so the rule would match ` +
    `transactions that have nothing to do with "${field}" as you meant it, and miss the ones ` +
    `you wanted. ${alternative}`
  );
}

/**
 * The same thing, for a rule that already exists.
 *
 * Rules created before this was refused are still in the budget and still
 * firing. They cannot be found by reading them, because what makes them wrong
 * is invisible in the listing: the condition looks ordinary.
 */
export function warnTextOpOnIdField(field: string, op: string): string {
  const alternative =
    field === 'payee'
      ? 'imported_payee for text, or `is` or `oneOf` with a payee name'
      : `\`is\` or \`oneOf\` with a ${field} name`;
  return (
    `\`${op}\` on \`${field}\` compares against the internal id, not the name, so this rule ` +
    `may be firing on transactions it has nothing to do with. Rewrite it with ${alternative}.`
  );
}
