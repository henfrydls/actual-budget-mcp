/**
 * A name that is nothing but spaces, refused before anything is written
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
 */
export function requireName(given: string, what: string, outcome: string): string {
  const name = given.trim();
  if (name !== '') return name;
  throw new Error(
    `A ${what} needs a name, and "${given}" is nothing but spaces. Actual accepts it ` +
      `and stores a ${what} with no readable name, which nothing can find by name ` +
      `afterwards. ${outcome}`,
  );
}
