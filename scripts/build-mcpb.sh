#!/usr/bin/env bash
# Build the Desktop Extension (.mcpb) for Claude Desktop.
#
# The bundle is self-contained: it carries its dependencies and starts with
# `node server/index.js`. It used to launch `npx actual-budget-mcp@<version>`
# instead, and that was the wrong call, made by reasoning correctly about the
# native binary and never measuring the thing that actually broke.
#
# What launching through npx cost, measured rather than assumed:
#
#   - A first run downloads 307 MB before answering anything. Between 12 and 33
#     seconds on a good connection, in the same day on the same machine. On a
#     real install Claude Desktop gave up first and showed "could not connect";
#     the server finished installing minutes later and worked, by which time the
#     user had been told it was broken.
#   - A user of a desktop app has no reason to have a C++ toolchain, so
#     anything that compiles on install is out.
#   - The Node that runs it is whatever the host ships, so neither of those is
#     under our control.
#
# What the premise for that decision got wrong: it said better-sqlite3 ships no
# prebuilt binaries. It ships them, and how it ships them has changed twice,
# which is worth recording because the script changed with it.
#
#   up to 12.x  one binary per ABI and platform, as release downloads. The
#               bundle carried all of them and chose the match at startup
#               (src/utils/native-binding.ts), because a binary built for ABI
#               137 will not load on a Node reporting 127.
#   13.x on     N-API binaries inside the npm package, one per platform, no
#               ABI in the name. Nothing is downloaded and nothing is chosen:
#               `npm ci` puts them in place and better-sqlite3 resolves its own.
#               The releases carry no assets at all from 13.0.0 (21 July 2026),
#               so the old approach does not merely cost more, it finds nothing.
#
# The floor moved with it: N-API 10 arrives in Node 22.14, and on anything older
# the binary loads and then segfaults. src/utils/runtime-check.ts refuses to
# start there rather than letting that happen.
#
# The cost is honest and worth stating: the download is large, once, with a
# progress bar. The alternative was small, every install, in silence.
set -euo pipefail

cd "$(dirname "$0")/.."
ROOT=$(pwd)
OUT=${1:-"$ROOT/actual-budget-mcp.mcpb"}
STAGE=$(mktemp -d)
trap 'rm -rf "$STAGE"' EXIT

VERSION=$(node -p "require('$ROOT/package.json').version")
MANIFEST_VERSION=$(node -p "require('$ROOT/manifest.json').version")
if [ "$VERSION" != "$MANIFEST_VERSION" ]; then
  echo "manifest.json says $MANIFEST_VERSION but package.json says $VERSION" >&2
  exit 1
fi

# The manifest must start the bundled server, not a published package. A pin
# left behind here would quietly ship the old launch path.
COMMAND=$(node -p "require('$ROOT/manifest.json').server.mcp_config.command")
if [ "$COMMAND" != "node" ]; then
  echo "manifest launches '$COMMAND', expected 'node'" >&2
  exit 1
fi

npm run build >/dev/null

# The compiled server, and its dependencies resolved from the committed
# lockfile so the bundle contains the versions CI tested.
mkdir -p "$STAGE/server"
cp -r "$ROOT/dist/." "$STAGE/server/"
cp "$ROOT/package.json" "$ROOT/package-lock.json" "$STAGE/"
(cd "$STAGE" && npm ci --omit=dev --ignore-scripts --no-audit --no-fund >/dev/null)
rm -f "$STAGE/package-lock.json"

# ~10 MB of SQLite C sources, needed only to compile. The bundle never compiles.
rm -rf "$STAGE/node_modules/better-sqlite3/deps"

# The SQLite binaries, which now come inside the npm package.
#
# They used to be downloaded one per (ABI, platform) from better-sqlite3's
# GitHub releases, because the binary was tied to a Node ABI and Claude Desktop
# moves its own Node without asking: it went from 22.19.0 to 24.20.0, ABI 127 to
# 137, during a single afternoon of testing.
#
# better-sqlite3 13 ends both halves of that. The binaries are N-API, so one per
# platform covers every Node, and they ship in the package itself under
# `prebuilds/<platform>-<arch>.node`, resolved by its own `lib/binding.js`. The
# download is not just unnecessary now, it is impossible: no release from
# 13.0.0 onwards (21 July 2026) carries a single asset, while 12.12.0 carried
# 145. Building this with the old script against the new library downloaded
# nothing at all and stopped, which is how this was found.
#
# So `npm ci` above has already put them in place. What is left is to check they
# are there, because a bundle that cannot open a database must not ship.
PREBUILDS="$STAGE/node_modules/better-sqlite3/prebuilds"

# Which platforms must have one is read from the manifest rather than written
# here, so the promise and the contents cannot drift apart: `compatibility`
# tells a user their machine is supported before they install, and a bundle
# that says darwin and carries no darwin binary is a download that fails on
# first use. Either the binary is there or the claim comes out.
DECLARED=$(node -p "JSON.parse(require('fs').readFileSync('$ROOT/manifest.json','utf8')).compatibility.platforms.join(' ')")
MISSING=""
COUNT=0
for plat in $DECLARED; do
  # Per architecture, like the post-pack check. Counting a platform as present
  # because one of its two builds is there made `bundled N` read as a complete
  # set when it was not.
  for arch in x64 arm64; do
    if [ -f "$PREBUILDS/$plat-$arch.node" ]; then
      COUNT=$((COUNT + 1))
    else
      MISSING="$MISSING $plat-$arch"
    fi
  done
done

# musl is not in `compatibility` (it is not a platform Claude Desktop reports)
# and travels anyway: the package carries it, and an Alpine host is the one
# place a glibc binary silently is not enough.
for extra in linuxmusl-x64 linuxmusl-arm64; do
  [ -f "$PREBUILDS/$extra.node" ] && COUNT=$((COUNT + 1))
done

if [ -n "$MISSING" ]; then
  echo "manifest.json declares$MISSING but the package has no SQLite binary for it;" >&2
  echo "either the binary is missing or the claim should come out of compatibility.platforms" >&2
  exit 1
fi
if [ "$COUNT" -eq 0 ]; then
  echo "no SQLite binaries found in the package; refusing to ship a bundle that cannot open a database" >&2
  exit 1
fi
echo "bundled $COUNT SQLite binaries (N-API, one per platform)" >&2

# The manifest's tool list is generated from the server itself, not written by
# hand. Claude Desktop and the directory show it before anyone installs, so a
# hand-kept copy would drift the moment a tool is added or renamed - and this
# project has already had a version string fall behind in two of the five places
# it is written. Generating it means there is nothing to forget.
node --input-type=module -e "
  import { readFileSync, writeFileSync } from 'node:fs';
  const { registerAllTools } = await import('$ROOT/dist/tools/index.js');
  const tools = [];
  registerAllTools({ tool: (name, description, _schema, annotations) => {
    tools.push({ name, description: annotations?.title ?? description });
  } });
  const manifest = JSON.parse(readFileSync('$ROOT/manifest.json', 'utf8'));
  manifest.tools = tools.sort((a, b) => a.name.localeCompare(b.name));
  manifest.tools_generated = true;
  writeFileSync('$STAGE/manifest.json', JSON.stringify(manifest, null, 2) + '\\n');
  console.error('listed ' + tools.length + ' tools in the manifest');
"
cp "$ROOT/README.md" "$STAGE/README.md"
cp "$ROOT/LICENSE" "$STAGE/LICENSE"

npx --yes @anthropic-ai/mcpb@2.1.2 pack "$STAGE" "$OUT"

# Read back out of the archive, which is the only thing that ships.
#
# Every check above this line looks at the staging directory, and a review got
# three mutations past them for that reason: deleting the binaries after the
# check and before the pack produced a bundle with none in it and exit 0. What
# a user installs is the zip, so the zip is what gets inspected -- by its own
# script, so CI can run it against a bundle broken on purpose.
# Invoked through `bash` rather than directly: the execute bit is a property
# of the checkout, not of the repository as every clone sees it, and CI caught
# this the hard way with "Permission denied" after the bundle had been built.
# A failure here must not leave a packed file on disk to be mistaken for a good
# one: a review found 34 MB of broken bundle sitting next to an exit 1.
if ! bash "$(dirname "${BASH_SOURCE[0]}")/verify-mcpb.sh" "$OUT"; then
  rm -f "$OUT"
  echo "removed $OUT" >&2
  exit 1
fi

echo "built $OUT"
