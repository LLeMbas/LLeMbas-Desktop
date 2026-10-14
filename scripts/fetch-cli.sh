#!/usr/bin/env bash
# Put the LLeMbas CLI that LLeMbas Desktop carries where the bundle takes it from:
#   src-tauri/binaries/lembas   (a resource: installed in the app's own directory, never on PATH)
#
#   scripts/fetch-cli.sh [target-triple]      (default: this machine's, from rustc)
#
# The version is the one in lembas-cli.version. The files are checked exactly as the CLI's own
# get.sh checks them: SHA256SUMS signed by the release key in the namespace lembas-release, naming
# this version, and the binary matching it. Nothing unverified is bundled.
set -euo pipefail
cd "$(dirname "$0")/.."

VERSION="$(tr -d '[:space:]' < lembas-cli.version)"
TRIPLE="${1:-$(rustc -vV | sed -n 's/^host: //p')}"
BASE="${LEMBAS_CLI_RELEASES:-https://github.com/LLeMbas/LLeMbas-CLI/releases/download}/v${VERSION}"
PUBKEY="ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIDSZO3Byow7R3ZpOH3MCvpPIga2pZBzhfX5wXfNP1cLa"

case "$TRIPLE" in
  # The baseline build runs on any x86-64 CPU, not only those with AVX2: a desktop app meets
  # older machines than a server does.
  x86_64-unknown-linux-gnu) ASSET=lembas-linux-x64-baseline ;;
  aarch64-unknown-linux-gnu) ASSET=lembas-linux-arm64 ;;
  *) echo "fetch-cli: no LLeMbas CLI build for $TRIPLE yet" >&2; exit 1 ;;
esac

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
for f in SHA256SUMS SHA256SUMS.sig "$ASSET.gz"; do
  curl -fsSL --retry 3 -o "$work/$f" "$BASE/$f"
done

printf 'lembas-release %s\n' "$PUBKEY" > "$work/allowed"
ssh-keygen -Y verify -f "$work/allowed" -I lembas-release -n lembas-release \
  -s "$work/SHA256SUMS.sig" < "$work/SHA256SUMS" >/dev/null \
  || { echo "fetch-cli: SHA256SUMS is not signed by the release key" >&2; exit 1; }
[ "$(sed -n -E 's/^# lembas //p' "$work/SHA256SUMS" | head -n1)" = "$VERSION" ] \
  || { echo "fetch-cli: SHA256SUMS is not for $VERSION" >&2; exit 1; }
(cd "$work" && grep -E "  $ASSET\.gz\$" SHA256SUMS | sha256sum -c --strict --quiet -) \
  || { echo "fetch-cli: $ASSET.gz does not match SHA256SUMS" >&2; exit 1; }

mkdir -p src-tauri/binaries
gunzip -c "$work/$ASSET.gz" > src-tauri/binaries/lembas
chmod 755 src-tauri/binaries/lembas
rm -f src-tauri/binaries/lembas-*   # where an earlier version of this script put it
echo "fetch-cli: LLeMbas CLI $VERSION ($ASSET) -> src-tauri/binaries/lembas"
