#!/usr/bin/env bash
# Check a packed .mcpb carries a SQLite binary for every platform the manifest
# declares.
#
# Its own script so CI can run it against a deliberately broken bundle. A check
# that only ever runs on a good one cannot be shown to work, and this one
# replaces three that could not: a review deleted the binaries after the staging
# check and before the pack, and the build still exited 0.
set -euo pipefail

BUNDLE="${1:?usage: verify-mcpb.sh <bundle.mcpb> [manifest.json]}"
MANIFEST="${2:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/manifest.json}"

node --input-type=module -e "
  import { readFileSync } from 'node:fs';
  import { execFileSync } from 'node:child_process';

  const listed = execFileSync('unzip', ['-Z1', '$BUNDLE'], { encoding: 'utf8' })
    .split('\n')
    .filter((name) => name.endsWith('.node'));

  const manifest = JSON.parse(readFileSync('$MANIFEST', 'utf8'));
  const declared = manifest.compatibility.platforms;
  const missing = declared.filter(
    (plat) => !listed.some((name) => name.includes('/' + plat + '-')),
  );

  if (listed.length === 0) {
    console.error('the packed bundle contains no SQLite binary at all');
    process.exit(1);
  }
  if (missing.length > 0) {
    console.error(
      'the packed bundle has no SQLite binary for: ' + missing.join(', ') +
      ', which manifest.json declares as supported'
    );
    process.exit(1);
  }
  console.error('verified ' + listed.length + ' SQLite binaries inside the bundle');
"
