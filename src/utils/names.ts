/**
 * A name with nothing visible in it, refused before anything is written
 * (#245).
 *
 * Measured against the engine, one call at a time, with `"  "`:
 *
 *   createCategory        accepted, stored as ""
 *   updateCategory        accepted, stored as ""
 *   createCategoryGroup   accepted, stored as "   ", spaces and all
 *   updateCategoryGroup   accepted, stored as "  "
 *   createPayee           accepted, stored as "  "
 *   updatePayee           accepted, stored as "  "
 *
 * Both outcomes are bad in the same way and the second is worse: the thing
 * is still there, it is invisible in the app, and the only way back to it is
 * its id, which nobody has written down. Nothing in the reply said it
 * happened either, because the write did go through.
 *
 * One function rather than six checks, because six checks is five chances to
 * forget. It refuses rather than falling back to a default name: inventing
 * "Untitled" would be deciding something the caller did not ask for, and the
 * caller is one correction away from the name they meant.
 *
 * ## Why `trim()` is not the test
 *
 * `"​"` is a zero-width space, and `trim()` leaves it alone: it is not
 * whitespace, it is a format character. So it passed all six and stored a
 * name that is one invisible character long, which is the same invisible row
 * by another route. The test is whether anything is left once the spaces,
 * the format characters and the control characters are taken out: `\p{Z}`,
 * `\p{Cf}` and `\p{Cc}`.
 *
 * What is returned is the trimmed name, and callers write that. The engine
 * trims a category's name itself and does not trim a group's or a payee's,
 * so `"  Padded  "` was stored with its padding on four of the six.
 */
const INVISIBLE = /[\p{Z}\p{Cf}\p{Cc}]/gu;

/** How to show a name that cannot be shown, so the message is readable. */
function describeBlank(given: string): string {
  if (given === '') return 'this one is empty';
  const shown = [...given]
    .map((character) => {
      if (character === '\t') return '\\t';
      if (character === '\n') return '\\n';
      if (character === '\r') return '\\r';
      if (character === ' ') return ' ';
      // A tab printed as a tab, or a zero-width space printed as itself,
      // makes the message as unreadable as the name it is complaining about.
      if (/[\p{Cf}\p{Cc}]/u.test(character)) {
        return `\\u${(character.codePointAt(0) ?? 0).toString(16).padStart(4, '0')}`;
      }
      return character;
    })
    .join('');
  return `"${shown}" has nothing visible in it`;
}

export function requireName(given: string, what: string, outcome: string): string {
  const name = given.trim();
  if (name.replace(INVISIBLE, '') !== '') return name;
  throw new Error(
    `A ${what} needs a name, and ${describeBlank(given)}. Actual accepts it and stores a ` +
      `${what} with no readable name, which nothing can find by name afterwards. ${outcome}`,
  );
}
