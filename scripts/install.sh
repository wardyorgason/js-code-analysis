#!/usr/bin/env bash
# Installs skill/ as the js-code-analysis Claude Code skill (default ~/.claude/skills/js-code-analysis).
# Runs scripts/bundle.sh first if the vendored FTA/c8 are missing.
# Usage: scripts/install.sh [target-dir]
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TARGET="${1:-$HOME/.claude/skills/js-code-analysis}"

if [[ ! -d "$ROOT/skill/vendor/fta" || ! -d "$ROOT/skill/vendor/c8" ]]; then
  bash "$ROOT/scripts/bundle.sh"
fi

rm -rf "$TARGET"
mkdir -p "$(dirname "$TARGET")"
cp -R "$ROOT/skill" "$TARGET"
VERSION="$(node -p "require('$ROOT/package.json').version")"
{
  echo "name=js-code-analysis"
  echo "version=$VERSION"
  echo "installed=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  cat "$ROOT/skill/vendor/VERSIONS"
} > "$TARGET/VERSION"
echo "Installed js-code-analysis $VERSION to $TARGET"
