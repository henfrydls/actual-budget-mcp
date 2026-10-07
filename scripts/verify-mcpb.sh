#!/usr/bin/env bash
# Check a packed .mcpb carries a SQLite binary for every platform the manifest
# declares, in both architectures.
#
# Its own script so CI can run it against a deliberately broken bundle. A check
# that only ever runs on a good one cannot be shown to work, and this one
# replaces three that could not: a review deleted the binaries after the staging
# check and before the pack, and the build still exited 0.
set -euo pipefail

BUNDLE="${1:?usage: verify-mcpb.sh <bundle.mcpb> [manifest.json]}"
MANIFEST="${2:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/manifest.json}"

# The script body is single-quoted and the values go through argv. With double
# quotes, bash expands what it finds inside -- which it did, trying to run a
# line of JavaScript as a command and printing `verified: command not found`
# while still exiting 0.
node --input-type=module -e '
  import { readFileSync } from "node:fs";
  import { execFileSync } from "node:child_process";

  // slice(1), not slice(2): with `-e` there is no script path in argv, so the
  // arguments start one place earlier than they would in a file. Getting this
  // wrong made it unzip the manifest.
  const [bundle, manifestPath] = process.argv.slice(1);

  const listed = execFileSync("unzip", ["-Z1", bundle], { encoding: "utf8" })
    .split("\n")
    .filter((name) => name.endsWith(".node"));

  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const declared = manifest.compatibility.platforms;

  // Both architectures, not just the platform prefix. A review packed a bundle
  // carrying only the arm64 builds and an earlier version said `verified 3`
  // and exited 0 -- a bundle that fails for every Intel Mac and x64 Windows.
  const missing = [];
  for (const plat of declared) {
    for (const arch of ["x64", "arm64"]) {
      if (!listed.some((name) => name.endsWith("/" + plat + "-" + arch + ".node"))) {
        missing.push(plat + "-" + arch);
      }
    }
  }

  if (listed.length === 0) {
    console.error("the packed bundle contains no SQLite binary at all");
    process.exit(1);
  }
  if (missing.length > 0) {
    console.error(
      "the packed bundle has no SQLite binary for: " + missing.join(", ") +
      ". manifest.json declares " + declared.join(", ") +
      ", and each needs both x64 and arm64"
    );
    process.exit(1);
  }
  console.error("verified " + listed.length + " SQLite binaries inside the bundle");
' "$BUNDLE" "$MANIFEST"
