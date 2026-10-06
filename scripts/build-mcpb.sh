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
#   - better-sqlite3 publishes prebuilt binaries for ABI 127, 137, 141 and 147
#     only. Node 20 (ABI 115) and Node 23 (131) compile from source, so they
#     need a C++ toolchain, which a user of a desktop app has no reason to have.
#     Node 20 is the floor this project advertises.
#   - The Node that runs it is whatever the user has, so neither of those is
#     under our control.
#
# What the premise for that decision got wrong: it said better-sqlite3 ships no
# prebuilt binaries. It ships plenty, one per ABI and platform, as ordinary
# release downloads. So the bundle carries one for every ABI and platform it
# supports, and picks the match at startup (src/utils/native-binding.ts). That
# is what makes a single artifact correct whether the host runs it with its own
# Node or with the user's, a question we could not answer and no longer need to.
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
  found=""
  for arch in x64 arm64; do
    if [ -f "$PREBUILDS/$plat-$arch.node" ]; then
      COUNT=$((COUNT + 1))
      found="yes"
    fi
  done
  [ -n "$found" ] || MISSING="$MISSING $plat"
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
echo "built $OUT"
