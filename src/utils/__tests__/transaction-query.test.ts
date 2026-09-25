import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const SRC = fileURLToPath(new URL('../../', import.meta.url));

function sourceFiles(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === '__tests__') continue;
      sourceFiles(full, found);
    } else if (entry.endsWith('.ts')) {
      found.push(full);
    }
  }
  return found;
}

/**
 * A transactions query that does not decide what splits mean is blind to split
 * parents, silently: AQL defaults to `inline`, which adds `WHERE is_parent = 0`.
 *
 * That has been a real bug twice. In #91 the probe could never see a split it
 * had just written, so a saved split was reported as "not saved, and can be
 * retried" — four rounds of review missed it, because the mocks returned the
 * parent. In #82 a note on a split parent turns out to be unfindable by text
 * search, which is exactly where a reimbursement tag lands when a purchase is
 * split across categories.
 *
 * Nothing here makes anyone choose correctly. It makes the choice appear in the
 * diff, which is what was missing both times. A note in a document would not
 * have caught either one.
 */
describe('every transactions query decides what splits mean', () => {
  it('is built through the helper, never from the raw builder', () => {
    const offenders: string[] = [];

    for (const file of sourceFiles(SRC)) {
      if (file.endsWith('transaction-query.ts')) continue; // the helper itself
      const text = readFileSync(file, 'utf8');
      if (/\bapi\s*\.\s*q\s*\(\s*['"]transactions['"]/.test(text) ||
          /(^|[^.\w])q\s*\(\s*['"]transactions['"]/.test(text.replace(/api\s*\.\s*q/g, 'api_q'))) {
        offenders.push(file.slice(SRC.length));
      }
    }

    expect(
      offenders,
      'use transactionsQuery(splits) so the choice about split parents is visible',
    ).toEqual([]);
  });

  it('has no default, so the decision cannot be skipped by omission', async () => {
    const helper = readFileSync(join(SRC, 'utils', 'transaction-query.ts'), 'utf8');

    // A default would put the trap back: `inline` is the value that hides
    // parents, and it is the one anyone would reach for by accident.
    expect(helper).not.toMatch(/splits\s*[:=]\s*['"]inline['"]\s*\)/);
    expect(helper).toMatch(/splits: SplitHandling/);
  });
});
