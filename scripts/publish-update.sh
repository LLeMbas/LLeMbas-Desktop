#!/usr/bin/env bash
# Offer a release to installed copies of LLeMbas Desktop: sign its packages with the updater key
# and write the update manifest the app reads (https://llembas.eu/desktop/latest.json).
#
#   MINISIGN_KEY=path/to/updater.key scripts/publish-update.sh v0.3.0 path/to/LLeMbas-Website
#
# The packages are the ones release.yml published on GitHub for the tag, checked against that
# release's SHA256SUMS first. The app verifies each package's signature with the public key in
# src-tauri/tauri.conf.json before installing it, so the manifest's host need not be trusted.
# This writes site/desktop/latest.json in the website's checkout; committing and pushing it is
# what publishes the update.
set -euo pipefail
TAG="${1:?usage: publish-update.sh vX.Y.Z path/to/LLeMbas-Website}"
SITE="${2:?usage: publish-update.sh vX.Y.Z path/to/LLeMbas-Website}"
KEY="${MINISIGN_KEY:?set MINISIGN_KEY to the minisign secret key of the updater}"
VERSION="${TAG#v}"
BASE="https://github.com/LLeMbas/LLeMbas-Desktop/releases/download/$TAG"
DEB="llembas-desktop_${VERSION}_amd64.deb"
APPIMAGE="llembas-desktop_${VERSION}_amd64.AppImage"

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
for f in SHA256SUMS "$DEB" "$APPIMAGE"; do
  curl -fsSL --retry 3 -o "$work/$f" "$BASE/$f"
done
[ "$(sed -n -E 's/^# llembas-desktop //p' "$work/SHA256SUMS" | head -n1)" = "$VERSION" ] \
  || { echo "publish-update: SHA256SUMS is not for $VERSION" >&2; exit 1; }
(cd "$work" && grep -E "  ($DEB|$APPIMAGE)\$" SHA256SUMS | sha256sum -c --strict --quiet -) \
  || { echo "publish-update: the packages do not match SHA256SUMS" >&2; exit 1; }

sig() {
  # Tab-separated, with the version: the app refuses a package whose signature names another one.
  minisign -S -s "$KEY" -m "$work/$1" -x "$work/$1.minisig" \
    -t "$(printf 'timestamp:%s\tfile:%s\tversion:%s' "$(date +%s)" "$1" "$VERSION")" >/dev/null
  base64 -w0 "$work/$1.minisig"
}
notes="$(git tag -l --format='%(contents)' "$TAG" | sed '/-----BEGIN SSH SIGNATURE-----/,$d' | tail -n +3)"

mkdir -p "$SITE/site/desktop"
jq -n --arg v "$VERSION" --arg notes "$notes" --arg date "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --arg deb_url "$BASE/$DEB" --arg deb_sig "$(sig "$DEB")" \
  --arg app_url "$BASE/$APPIMAGE" --arg app_sig "$(sig "$APPIMAGE")" \
  '{version: $v, notes: $notes, pub_date: $date, platforms: {
     "linux-x86_64-deb": {url: $deb_url, signature: $deb_sig},
     "linux-x86_64-appimage": {url: $app_url, signature: $app_sig}}}' \
  > "$SITE/site/desktop/latest.json"
echo "publish-update: wrote $SITE/site/desktop/latest.json for $VERSION — commit and push it to publish"
