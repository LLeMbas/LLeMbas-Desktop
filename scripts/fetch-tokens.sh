#!/usr/bin/env bash
# Put the LLeMbas server's design tokens where the app's own pages read them from:
#   ui/tokens.css   (a copy of the server's static/css/tokens.css, never edited by hand)
#
#   scripts/fetch-tokens.sh <server-ref>      copy the tokens at that ref (a tag such as v1.3.0,
#                                             or HEAD) and write tokens.lock.json
#   scripts/fetch-tokens.sh                   verify: ui/tokens.css matches tokens.lock.json
#
# The server is a git checkout, LLeMbas beside this repository by default (LLEMBAS_SERVER names
# another). The one change made to the copy: the @font-face rules are left out, with the comment
# above them. They name woff2 files the server vendors and the app does not carry; the app's pages
# fall through the same `--font-ui` stack to the system's monospace face, and without the rules
# the webview does not ask for two files that are not there.
#
# tokens.lock.json records the ref, the commit it resolved to, and the SHA-256 of ui/tokens.css
# as written, which is what verify checks. Like fetch-cli.sh and lembas-cli.version: the file in
# the tree says which server version the look comes from, and CI refuses a copy that drifted.
set -euo pipefail
cd "$(dirname "$0")/.."

SERVER="${LEMBAS_SERVER:-../LLeMbas}"
SOURCE="src/lembas/web/static/css/tokens.css"
OUT="ui/tokens.css"
LOCK="tokens.lock.json"

sha() { sha256sum "$1" | cut -d' ' -f1; }

if [ $# -eq 0 ]; then
  [ -f "$LOCK" ] || { echo "fetch-tokens: no $LOCK; run with a server ref first" >&2; exit 1; }
  [ -f "$OUT" ] || { echo "fetch-tokens: no $OUT; run with a server ref first" >&2; exit 1; }
  want="$(sed -n -E 's/^ *"sha256": *"([0-9a-f]{64})".*/\1/p' "$LOCK" | head -n1)"
  ref="$(sed -n -E 's/^ *"tag": *"([^"]+)".*/\1/p' "$LOCK" | head -n1)"
  have="$(sha "$OUT")"
  if [ "$want" != "$have" ]; then
    echo "fetch-tokens: $OUT does not match $LOCK (server $ref): $have, expected $want" >&2
    exit 1
  fi
  echo "fetch-tokens: $OUT matches $LOCK (server $ref)"
  exit 0
fi

REF="$1"
[ -d "$SERVER/.git" ] || [ -f "$SERVER/.git" ] \
  || { echo "fetch-tokens: $SERVER is not a git checkout of the LLeMbas server (set LEMBAS_SERVER)" >&2; exit 1; }
commit="$(git -C "$SERVER" rev-parse --verify --quiet "$REF^{commit}")" \
  || { echo "fetch-tokens: $REF is not a commit in $SERVER" >&2; exit 1; }

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
git -C "$SERVER" show "$commit:$SOURCE" > "$work/tokens.css" \
  || { echo "fetch-tokens: $SOURCE is not in $SERVER at $REF" >&2; exit 1; }

# A comment immediately before an @font-face goes with it; then every @font-face block.
perl -0pe 's#/\*(?:(?!\*/).)*?\*/\s*(?=\@font-face)##gs; s#\@font-face\s*\{[^}]*\}\s*##g' \
  "$work/tokens.css" > "$work/body.css"
grep -q -- '--border:' "$work/body.css" && grep -q -- '--bg:' "$work/body.css" \
  || { echo "fetch-tokens: $SOURCE at $REF has no --border or --bg: not the tokens file" >&2; exit 1; }
! grep -q '@font-face' "$work/body.css" \
  || { echo "fetch-tokens: an @font-face survived the strip; fix the script" >&2; exit 1; }

{
  printf '/* LLeMbas %s (%s) static/css/tokens.css, copied by scripts/fetch-tokens.sh: do not edit.\n' "$REF" "${commit:0:12}"
  printf '   The font-face rules are left out; the app bundles no font. */\n'
  cat "$work/body.css"
} > "$work/out.css"

cp "$work/out.css" "$OUT"
printf '{\n  "tag": "%s",\n  "commit": "%s",\n  "sha256": "%s"\n}\n' "$REF" "$commit" "$(sha "$OUT")" > "$LOCK"
echo "fetch-tokens: LLeMbas $REF (${commit:0:12}) $SOURCE -> $OUT; $LOCK written"
