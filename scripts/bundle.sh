#!/usr/bin/env bash
# Vendors the skill's runtime dependencies into skill/vendor so the analyzer never calls npx:
#   - FTA prebuilt binaries (from the fta-cli npm tarball; same binaries fta-cli runs)
#   - c8 with its production dependencies (coverage for mocha / node:test / ava / other runners)
# npm is used here, at bundle time only. Re-run after bumping a version below.
# Usage: scripts/bundle.sh [--all-platforms]
set -euo pipefail

# Bumping FTA_VERSION changes the Rust crates inside the binaries: regenerate
# skill/licenses/FTA_THIRD_PARTY_LICENSES.txt and skill/THIRD_PARTY_NOTICES.md from FTA's Cargo.lock.
FTA_VERSION=3.0.1
C8_VERSION=12.0.0
TARGETS=(fta-aarch64-apple-darwin fta-x86_64-apple-darwin fta-x86_64-unknown-linux-musl fta-aarch64-unknown-linux-musl)
if [[ "${1:-}" == "--all-platforms" ]]; then
  TARGETS+=(fta-arm-unknown-linux-musleabi fta-x86_64-pc-windows-msvc fta-aarch64-pc-windows-msvc)
fi

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VENDOR="$ROOT/skill/vendor"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

rm -rf "$VENDOR"
mkdir -p "$VENDOR/fta" "$VENDOR/c8"

echo "Fetching fta-cli@$FTA_VERSION"
(cd "$WORK" && npm pack "fta-cli@$FTA_VERSION" --silent >/dev/null && tar xzf "fta-cli-$FTA_VERSION.tgz")
for t in "${TARGETS[@]}"; do
  cp -R "$WORK/package/binaries/$t" "$VENDOR/fta/$t"
  chmod +x "$VENDOR/fta/$t"/fta* 2>/dev/null || true
done
cp "$WORK/package/package.json" "$VENDOR/fta/package.json"
# fta-cli is MIT but the tarball omits the license file, so take it from the matching git tag
curl -fsSL "https://raw.githubusercontent.com/sgb-io/fta/v$FTA_VERSION/LICENSE.md" -o "$VENDOR/fta/LICENSE.md"

echo "Installing c8@$C8_VERSION"
mkdir -p "$WORK/c8"
(cd "$WORK/c8" && npm init -y >/dev/null && npm install "c8@$C8_VERSION" --omit=dev --no-audit --no-fund --silent)
cp -R "$WORK/c8/node_modules" "$VENDOR/c8/node_modules"

cat > "$VENDOR/VERSIONS" <<EOF
fta-cli=$FTA_VERSION
c8=$C8_VERSION
fta-targets=${TARGETS[*]}
EOF
du -sh "$VENDOR"/* | sed "s|$ROOT/||"
