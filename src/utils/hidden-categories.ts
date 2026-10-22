/**
 * What a listing of categories leaves out, in one place (#248).
 *
 * `get_categories` and the `actual://categories` resource are two ways of
 * asking the same question, and they answered differently: the tool left out
 * hidden categories and the ones whose group is hidden (#238), and the
 * resource left out only the first kind, so it listed categories the app does
 * not show and the tool had just said it was leaving out.
 *
 * Two surfaces with the same rule written twice is the shape that produced
 * that, so the rule is written here and both read it.
 */

/** A category row with the fields a listing is made of. */
export interface CategoryRow {
  id: string;
  name: string;
  hidden?: boolean;
  group_id?: string;
}

/** A group row, which carries a `hidden` flag of its own. */
export interface GroupRow {
  id: string;
  name: string;
  is_income?: boolean;
  hidden?: boolean;
}

/**
 * Whether the group this category is in is hidden.
 *
 * Measured: hiding a group leaves every category in it with `hidden: false`,
 * and the app shows none of them. So the category's own flag is half the
 * question.
 */
export function inHiddenGroup(cat: CategoryRow, groups: Map<string, GroupRow>): boolean {
  return Boolean(cat.group_id !== undefined && groups.get(cat.group_id)?.hidden);
}

/** The two counts, kept apart because different tools undo them. */
export function countHidden(
  categories: CategoryRow[],
  groups: Map<string, GroupRow>,
): { own: number; byGroup: number } {
  let own = 0;
  let byGroup = 0;
  for (const cat of categories) {
    if (cat.hidden) own += 1;
    else if (inHiddenGroup(cat, groups)) byGroup += 1;
  }
  return { own, byGroup };
}

/**
 * The closing line, when there is something a listing does not show.
 *
 * The two counts are kept apart because they are undone by different tools:
 * a hidden category comes back with `update_category`, and a category in a
 * hidden group comes back with `update_category_group`, which is not
 * something a reply can expect anyone to work out.
 *
 * `how` is how to see them from wherever this is being read, which is the
 * only part that differs between the tool and the resource.
 */
export function notListedLine(own: number, byGroup: number, how: string): string | undefined {
  if (own + byGroup === 0) return undefined;

  const parts: string[] = [];
  if (own > 0) parts.push(`${own} hidden ${own === 1 ? 'category' : 'categories'}`);
  if (byGroup > 0) {
    parts.push(`${byGroup} ${byGroup === 1 ? 'category' : 'categories'} in a hidden group`);
  }

  return `Not listed: ${parts.join(', and ')}. ${how}`;
}
