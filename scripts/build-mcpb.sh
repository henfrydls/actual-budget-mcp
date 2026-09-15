#!/usr/bin/env bash
# Build the Desktop Extension (.mcpb) for Claude Desktop.
#
# Why the bundle launches through npm instead of shipping its dependencies:
#
#   @actual-app/api depends on better-sqlite3, which compiles a native binary
#   for the machine it is installed on (build/Release/better_sqlite3.node) and
#   ships no prebuilt binaries in the package. A bundle packed on Linux would
#   therefore carry a Linux binary and fail on Windows and macOS — the two
#   platforms Desktop Extension review cares most about.
#
#   Publishing three platform-specific bundles would work, but every one of them
#   would have to be built and tested separately on its own machine, and the
#   version pinned inside each would be a fourth copy of the version to keep in
#   step. Launching through npm lets npm do what it already does well: resolve
#   the right native binary for whoever installs it.
#
#   The cost is honest and worth stating: the machine needs Node, and the first
#   run downloads the package. In exchange the bundle is kilobytes rather than
#   tens of megabytes, and there is exactly one artifact to test.
#
# The version in manifest.json is pinned rather than floating, so an extension
# installed today keeps working the way it was reviewed.
#
# The consequence is easy to forget and cost us most of an afternoon: a bundle
# built from a commit whose fix is not published yet still launches the last
# published version, so it does not contain the fix. Building the bundle is not
# releasing it. To test a change end to end, publish first.
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

# The pinned package the manifest launches must be the version being built,
# or the extension would install something other than what was tested.
PINNED=$(node -p "require('$ROOT/manifest.json').server.mcp_config.args.at(-1)")
if [ "$PINNED" != "actual-budget-mcp@$VERSION" ]; then
  echo "manifest launches $PINNED, expected actual-budget-mcp@$VERSION" >&2
  exit 1
fi

npm run build >/dev/null

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

# entry_point is required by the manifest schema and must exist, so the compiled
# server is included even though mcp_config launches the published package. It
# also makes the bundle inspectable: anyone can unpack it and read the code that
# will run, rather than taking the npm package on trust.
mkdir -p "$STAGE/server"
cp -r "$ROOT/dist/." "$STAGE/server/"

npx --yes @anthropic-ai/mcpb@2.1.2 pack "$STAGE" "$OUT"
echo "built $OUT"
