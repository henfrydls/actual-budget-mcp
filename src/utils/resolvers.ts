import * as api from '@actual-app/api';
import { ensureConnection } from '../connection.js';

/**
 * Match candidates by name, preferring an exact (case-insensitive) match.
 * Substring matching only runs as a fallback when no exact match exists.
 * This prevents "ambiguous" errors when a name is a prefix/substring of
 * another (e.g. "Savings" vs "Savings - Emergency Fund"). See #22/#27.
 */
function matchByName<T>(items: T[], nameOrId: string, getName: (item: T) => string): T[] {
  const lower = nameOrId.toLowerCase();
  const exact = items.filter((item) => getName(item).toLowerCase() === lower);
  if (exact.length > 0) return exact;
  return items.filter((item) => getName(item).toLowerCase().includes(lower));
}

/**
 * The same resolution, against a list already in hand.
 *
 * A batch resolves many names at once (#83), and calling the loading versions
 * per row would fetch every account and category once per transaction: for the
 * 22 movements of one day, 44 round trips to answer questions whose answers
 * cannot change between them. The loading versions below now call these, so
 * there is one rule rather than two that can drift.
 */
export function resolveAccountIn(
  accounts: Array<{ id: string; name: string; closed?: boolean }>,
  nameOrId: string,
): string {
  const byId = accounts.find((a) => a.id === nameOrId);
  if (byId) return byId.id;

  const candidates = accounts.filter((a) => !a.closed);
  const matches = matchByName(candidates, nameOrId, (a) => a.name);

  if (matches.length === 0) {
    const names = candidates.map((a) => a.name).join(', ');
    throw new Error(`No account found matching "${nameOrId}". Available: ${names}`);
  }
  if (matches.length > 1) {
    const names = matches.map((a) => a.name).join(', ');
    throw new Error(`Ambiguous account name "${nameOrId}". Matches: ${names}`);
  }
  return matches[0].id;
}

export function resolveCategoryIn(
  categories: Array<{ id: string; name: string; hidden?: boolean; group_id?: string }>,
  nameOrId: string,
): string {
  const byId = categories.find((c) => c.id === nameOrId);
  if (byId) return byId.id;

  const candidates = categories.filter((c) => 'group_id' in c && !c.hidden);
  const cats = matchByName(candidates, nameOrId, (c) => c.name);

  if (cats.length === 0) {
    const names = candidates.map((c) => c.name).join(', ');
    throw new Error(`No category found matching "${nameOrId}". Available: ${names}`);
  }
  if (cats.length > 1) {
    const names = cats.map((c) => c.name).join(', ');
    throw new Error(`Ambiguous category name "${nameOrId}". Matches: ${names}`);
  }
  return cats[0].id;
}

/**
 * A payee by id or by its whole name, against a list already in hand.
 *
 * By the **whole** name, where `resolveAccountId` and `resolveCategoryId` fall
 * back to part of one. The difference is what the answer is used for: those
 * resolve something for one call, and this one is stored. A rule keeps running
 * until somebody deletes it, so "Uber" saved as "Uber Eats" because that was
 * the only payee containing it goes on recategorising transactions for months,
 * and the reply that said the rule was created named "Uber".
 *
 * Case is ignored, because that is a way of writing the same name rather than
 * a different one.
 *
 * Transfer payees are left out of the name match by `transfer_acct`. They carry
 * their account's name, so "Checking" would otherwise find the payee every
 * transfer into that account uses. Asked for by id, any payee is found.
 *
 * Two payees can share a name: measured, `createPayee` accepts a second
 * "Amazon" and both come back. That is ambiguous and is refused, since picking
 * either would be picking at random.
 */
export function resolvePayeeIn(
  payees: Array<{ id: string; name: string; transfer_acct?: string | null }>,
  nameOrId: string,
): string {
  // Transfer payees are left out of the name match by `transfer_acct`. They
  // carry their account's name, so "Checking" would otherwise find the payee
  // every transfer into that account uses. Asked for by id, any payee is
  // found, which is why the id lookup happens inside `resolveByWholeName`
  // against the unfiltered list.
  return resolveByWholeName(payees, payees.filter((p) => !p.transfer_acct && p.name !== ''), nameOrId, 'payee');
}

/**
 * The same matching, for anything a rule stores by id.
 *
 * Shared because the four of them have to answer alike: a rule is stored and
 * keeps running, so a name matched loosely in one field and strictly in
 * another is the kind of difference that is invisible until a rule does
 * something nobody asked for.
 *
 * `all` is searched by id and `candidates` by name. They differ where some
 * entries can be named but not matched, which is the transfer payees.
 */
/** "a" or "an", so a message built from a field name reads like English. */
function article(label: string): string {
  return /^[aeiou]/i.test(label) ? 'An' : 'A';
}

export function resolveByWholeName(
  all: Array<{ id: string; name: string }>,
  candidates: Array<{ id: string; name: string }>,
  nameOrId: string,
  label: string,
): string {
  const byId = all.find((item) => item.id === nameOrId);
  if (byId) return byId.id;

  const wanted = nameOrId.trim().toLowerCase();
  const matches = candidates.filter((item) => item.name.trim().toLowerCase() === wanted);

  // An id that is not in the list is a different problem from a name that
  // matched nothing, and the advice about whole names reads as nonsense next
  // to a UUID. Measured for accounts: a closed one is returned by neither
  // `getAccounts()` nor a query, so it cannot be reached at all, by name or by
  // id.
  if (matches.length === 0 && /^[0-9a-f-]{36}$/i.test(nameOrId.trim())) {
    throw new Error(
      `No ${label} with the id "${nameOrId}". It may have been deleted, or, for an account, ` +
        `closed: a closed account is not returned by the API at all, so nothing here can ` +
        `name it.`,
    );
  }

  if (matches.length === 0) {
    // The entries that contain what was asked for, where there are any: those
    // are what someone meant, and listing everything in the budget instead
    // buries it.
    const near = candidates.filter((item) => item.name.toLowerCase().includes(wanted));
    const detail =
      near.length > 0
        ? ` Did you mean: ${near.map((item) => item.name).join(', ')}?`
        : ` Available: ${candidates.map((item) => item.name).join(', ')}`;
    throw new Error(
      `No ${label} found matching "${nameOrId}". ${article(label)} ${label} is matched by ` +
        `its whole name here, not by part of one.${detail}`,
    );
  }
  if (matches.length > 1) {
    const names = matches.map((item) => `${item.name} (${item.id})`).join(', ');
    throw new Error(
      `Ambiguous ${label} name "${nameOrId}". More than one ${label} is called that: ` +
        `${names}. Give the id instead.`,
    );
  }
  return matches[0].id;
}

export async function resolveAccountId(nameOrId: string): Promise<string> {
  await ensureConnection();
  const accounts = await api.getAccounts();

  // Exact ID match
  const byId = accounts.find((a) => a.id === nameOrId);
  if (byId) return byId.id;

  // Case-insensitive name match (exact wins over substring)
  const candidates = accounts.filter((a) => !a.closed);
  const matches = matchByName(candidates, nameOrId, (a) => a.name);

  if (matches.length === 0) {
    const names = accounts
      .filter((a) => !a.closed)
      .map((a) => a.name)
      .join(', ');
    throw new Error(
      `No account found matching "${nameOrId}". Available: ${names}`,
    );
  }
  if (matches.length > 1) {
    const names = matches.map((a) => a.name).join(', ');
    throw new Error(
      `Ambiguous account name "${nameOrId}". Matches: ${names}`,
    );
  }

  return matches[0].id;
}

/**
 * `includeHidden` is for the one tool that has to address a hidden category.
 *
 * A hidden category is left out of the name match everywhere else on
 * purpose: it is hidden because nobody wants it offered, and a transaction
 * should not land in one by a name that also fits something visible.
 *
 * `update_category` is the exception, because unhiding one is its job.
 * Measured against the engine while fixing #218: hide `Groceries` and it
 * stops resolving by name, so it can only be brought back by id, and the
 * error says `No category found matching "Groceries"` and lists the ones
 * that are visible. The category is right there.
 */
export async function resolveCategoryId(
  nameOrId: string,
  options: { includeHidden?: boolean } = {},
): Promise<string> {
  await ensureConnection();
  const categories = await api.getCategories();

  // Exact ID match
  const byId = categories.find((c) => c.id === nameOrId);
  if (byId) return byId.id;

  // Case-insensitive name match (filter only actual categories, not groups;
  // exact wins over substring)
  const visible = (c: { hidden?: boolean }) => options.includeHidden === true || !c.hidden;
  const candidates = categories.filter((c) => 'group_id' in c && visible(c));
  const cats = matchByName(candidates, nameOrId, (c) => c.name);

  if (cats.length === 0) {
    const names = categories
      .filter((c) => 'group_id' in c && visible(c))
      .map((c) => c.name)
      .join(', ');
    // A hidden one that matches is the likeliest reason for being here, and
    // the list above cannot say so.
    const hiddenMatch =
      options.includeHidden === true
        ? []
        : matchByName(
            categories.filter((c) => 'group_id' in c && c.hidden),
            nameOrId,
            (c) => c.name,
          );
    const alsoHidden =
      hiddenMatch.length === 0
        ? ''
        : ` A hidden category is named "${hiddenMatch[0].name}": unhide it with ` +
          `update_category, or pass its id.`;
    throw new Error(
      `No category found matching "${nameOrId}". Available: ${names}.${alsoHidden}`,
    );
  }
  if (cats.length > 1) {
    const names = cats.map((c) => c.name).join(', ');
    throw new Error(
      `Ambiguous category name "${nameOrId}". Matches: ${names}`,
    );
  }

  return cats[0].id;
}

/**
 * Find a payee id by exact name, or undefined when there is no such payee.
 *
 * Transfer payees are excluded: Actual stores them with an empty name and a
 * `transfer_acct`, so a blank (or account-named) lookup would otherwise return
 * one and silently turn a plain transaction into a one-sided transfer.
 */
export async function resolvePayeeName(name: string): Promise<string | undefined> {
  const lower = name.trim().toLowerCase();
  if (lower === '') return undefined;

  await ensureConnection();
  const payees = await api.getPayees();
  const match = payees.find(
    (p) => !p.transfer_acct && p.name.toLowerCase() === lower,
  );
  return match?.id;
}

export async function resolveCategoryGroupId(nameOrId: string): Promise<string> {
  await ensureConnection();
  const groups = await api.getCategoryGroups();

  // Exact ID match
  const byId = groups.find((g) => g.id === nameOrId);
  if (byId) return byId.id;

  // Case-insensitive name match (exact wins over substring)
  const matches = matchByName(groups, nameOrId, (g) => g.name);

  if (matches.length === 0) {
    const names = groups.map((g) => g.name).join(', ');
    throw new Error(
      `No category group found matching "${nameOrId}". Available: ${names}`,
    );
  }
  if (matches.length > 1) {
    const names = matches.map((g) => g.name).join(', ');
    throw new Error(
      `Ambiguous category group name "${nameOrId}". Matches: ${names}`,
    );
  }

  return matches[0].id;
}

export async function resolvePayeeId(nameOrId: string): Promise<string> {
  await ensureConnection();
  const payees = await api.getPayees();

  // Exact ID match
  const byId = payees.find((p) => p.id === nameOrId);
  if (byId) return byId.id;

  // Case-insensitive name match (exclude transfer payees; exact wins over substring)
  const candidates = payees.filter(
    (p) => !p.name.startsWith('Transfer:') && p.name !== '',
  );
  const matches = matchByName(candidates, nameOrId, (p) => p.name);

  if (matches.length === 0) {
    const names = payees
      .filter((p) => !p.name.startsWith('Transfer:') && p.name !== '')
      .map((p) => p.name)
      .join(', ');
    throw new Error(
      `No payee found matching "${nameOrId}". Available: ${names}`,
    );
  }
  if (matches.length > 1) {
    const names = matches.map((p) => p.name).join(', ');
    throw new Error(
      `Ambiguous payee name "${nameOrId}". Matches: ${names}`,
    );
  }

  return matches[0].id;
}
