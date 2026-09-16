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

# One binary per ABI and platform, laid out the way native-binding.ts looks for
# them. Only ABIs with published prebuilds are listed: 115 (Node 20) and 131
# (Node 23) have none, and a bundle cannot compile one.
BETTER_SQLITE3=$(node -p "require('$ROOT/node_modules/better-sqlite3/package.json').version")
BASE="https://github.com/WiseLibs/better-sqlite3/releases/download/v${BETTER_SQLITE3}"
ABIS="127 137 141 147"
PLATFORMS="darwin-arm64 darwin-x64 win32-x64 win32-arm64 linux-x64 linux-arm64"

mkdir -p "$STAGE/server/prebuilds"
COUNT=0
for abi in $ABIS; do
  for plat in $PLATFORMS; do
    key="node-v${abi}-${plat}"
    url="${BASE}/better-sqlite3-v${BETTER_SQLITE3}-${key}.tar.gz"
    dir="$STAGE/server/prebuilds/$key"
    mkdir -p "$dir"
    if curl -sfL "$url" | tar xz -C "$dir" --strip-components=2 build/Release/better_sqlite3.node 2>/dev/null; then
      COUNT=$((COUNT + 1))
    else
      # A missing combination is not fatal, but it must not pass unnoticed:
      # a user on it would get "no SQLite binary for <key>" at startup.
      rmdir "$dir"
      echo "note: no prebuild published for $key" >&2
    fi
  done
done
if [ "$COUNT" -eq 0 ]; then
  echo "no prebuilt SQLite binaries could be downloaded; refusing to ship a bundle that cannot open a database" >&2
  exit 1
fi
echo "bundled $COUNT SQLite binaries" >&2

# Record which one is in place, so a start whose ABI already matches copies
# nothing. The binary npm installed here is built for this machine's ABI.
RELEASE_DIR="$STAGE/node_modules/better-sqlite3/build/Release"
mkdir -p "$RELEASE_DIR"
HOST_KEY="node-v$(node -p 'process.versions.modules')-$(node -p 'process.platform')-$(node -p 'process.arch')"
if [ -f "$STAGE/server/prebuilds/$HOST_KEY/better_sqlite3.node" ]; then
  cp "$STAGE/server/prebuilds/$HOST_KEY/better_sqlite3.node" "$RELEASE_DIR/better_sqlite3.node"
  echo "$HOST_KEY" > "$RELEASE_DIR/.installed-abi"
fi

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
