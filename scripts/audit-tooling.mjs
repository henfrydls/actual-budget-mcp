#!/usr/bin/env node
// The audit gate for the whole dependency tree, development tooling included
// (#212).
//
// `npm audit --omit=dev` guards what users install and is a separate step.
// This one guards what the repository runs, and it exists because the honest
// version of "we look at the full tree" is a check that fails.
//
// It is not `npm audit --audit-level=high`, for one reason: npm cannot ignore
// a single advisory. The day one lands in the test runner with no fix
// available, the choice that command offers is to carry it silently or to
// switch the step off for everything, and this project has already run the
// second one for a year. So an advisory can be carried, by GHSA id, with a
// reason written beside it in `.github/audit-allowlist.json`. Everything else
// at high or above fails.
//
//   node scripts/audit-tooling.mjs
//   node scripts/audit-tooling.mjs --stdin --allowlist <path>   (for the tests)
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const GATE = new Set(['high', 'critical']);

/**
 * The advisories at or above the gate, as {ghsa, package, severity, title}.
 *
 * `npm audit --json` reports one entry per affected package, and the
 * advisory itself is inside `via`, where an entry is either an object (the
 * advisory) or a string (another package it came through). The GHSA id is
 * only in the advisory's url, so that is where it is read from.
 */
export function findings(audit) {
  const found = new Map();
  for (const vulnerability of Object.values(audit?.vulnerabilities ?? {})) {
    for (const via of vulnerability?.via ?? []) {
      if (typeof via !== 'object' || !GATE.has(via.severity)) continue;
      const ghsa = String(via.url ?? '').split('/').pop();
      if (!ghsa.startsWith('GHSA-')) continue;
      found.set(ghsa, {
        ghsa,
        package: via.name ?? vulnerability.name,
        severity: via.severity,
        title: via.title ?? '',
      });
    }
  }
  return [...found.values()];
}

/** What the allowlist does not account for, and what it accounts for twice. */
export function review(audit, allowed) {
  const all = findings(audit);
  const names = new Set(all.map((f) => f.ghsa));
  return {
    unallowed: all.filter((f) => !(f.ghsa in allowed)),
    carried: all.filter((f) => f.ghsa in allowed),
    stale: Object.keys(allowed).filter((ghsa) => !names.has(ghsa)),
  };
}

function readAudit(fromStdin) {
  if (fromStdin) return JSON.parse(readFileSync(0, 'utf8'));
  try {
    // Exits non-zero whenever it finds anything, which is most of the point,
    // so the output is read either way.
    return JSON.parse(execFileSync('npm', ['audit', '--json'], { encoding: 'utf8' }));
  } catch (error) {
    const out = error?.stdout;
    if (typeof out === 'string' && out.trim() !== '') return JSON.parse(out);
    throw error;
  }
}

const args = process.argv.slice(2);
const allowlistPath =
  args.includes('--allowlist')
    ? args[args.indexOf('--allowlist') + 1]
    : '.github/audit-allowlist.json';

const allowed = JSON.parse(readFileSync(allowlistPath, 'utf8')).allowed ?? {};
const { unallowed, carried, stale } = review(readAudit(args.includes('--stdin')), allowed);

for (const found of carried) {
  console.log(`carried: ${found.ghsa} ${found.severity} in ${found.package}`);
  console.log(`         ${allowed[found.ghsa]}`);
}
for (const ghsa of stale) {
  console.log(`::notice::${ghsa} is in the allowlist and no longer in the tree; take it out`);
}

if (unallowed.length === 0) {
  console.log(`no high or critical advisory outside the allowlist (${carried.length} carried)`);
  process.exit(0);
}

for (const found of unallowed) {
  console.log(`${found.ghsa} ${found.severity} in ${found.package}: ${found.title}`);
}
console.log(
  `::error::${unallowed.length} advisory or advisories at high or above are not accounted for. ` +
    'Fix them, or carry one deliberately by adding its GHSA id to .github/audit-allowlist.json ' +
    'with the reason and when to revisit.',
);
process.exit(1);
