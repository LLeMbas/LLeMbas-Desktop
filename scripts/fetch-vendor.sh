#!/usr/bin/env bash
# Put the server's vendored CodeMirror build where the app's own pages read it from:
#   ui/vendor/*.mjs   (copies of the server's static/vendor/cm-*.mjs and lezer-*.mjs)
#
#   scripts/fetch-vendor.sh <server-ref>      copy the modules at that ref (a tag such as
#                                             v2.0.0-beta.1, or a branch) and write vendor.lock.json
#   scripts/fetch-vendor.sh                   verify: ui/vendor matches vendor.lock.json
#
# The server is a git checkout, LLeMbas beside this repository by default (LLEMBAS_SERVER names
# another). Each module is checked against the server's own pin (its scripts/vendor.lock.json, at
# the same ref) before it is copied, so what the app carries is exactly what the server serves.
#
# The one change made to a copy: the server loads these modules through an import map
# ("@codemirror/view" -> its file), which the app's pages do not have -- an inline import map is a
# script the content security policy would have to allow. So the bare names in `import`/`from`
# are rewritten to the sibling files ("./cm-view.mjs"), and nothing else is touched.
#
# vendor.lock.json records the ref, the commit it resolved to, and for every file the server's
# SHA-256 and the copy's, which is what verify checks. Like fetch-tokens.sh: the file in the tree
# says which server version the editor comes from, and CI refuses a copy that drifted.
set -euo pipefail
cd "$(dirname "$0")/.."

SERVER="${LEMBAS_SERVER:-../LLeMbas}"
SOURCE="src/lembas/web/static/vendor"
SERVER_LOCK="scripts/vendor.lock.json"
OUT="ui/vendor"
LOCK="vendor.lock.json"

sha() { sha256sum "$1" | cut -d' ' -f1; }

if [ $# -eq 0 ]; then
  [ -f "$LOCK" ] || { echo "fetch-vendor: no $LOCK; run with a server ref first" >&2; exit 1; }
  ref="$(sed -n -E 's/^ *"tag": *"([^"]+)".*/\1/p' "$LOCK" | head -n1)"
  bad=0
  count=0
  # One file a line: "name": {"server": "…", "copy": "…"}
  while IFS=$'\t' read -r name want; do
    count=$((count + 1))
    if [ ! -f "$OUT/$name" ]; then
      echo "fetch-vendor: $OUT/$name is missing" >&2
      bad=1
    elif [ "$(sha "$OUT/$name")" != "$want" ]; then
      echo "fetch-vendor: $OUT/$name does not match $LOCK (server $ref)" >&2
      bad=1
    fi
  done < <(sed -n -E 's/^ *"([a-z0-9-]+\.mjs)": *\{"server": *"[0-9a-f]{64}", *"copy": *"([0-9a-f]{64})"\}.*/\1\t\2/p' "$LOCK")
  for f in "$OUT"/*.mjs; do
    grep -q "\"$(basename "$f")\"" "$LOCK" || { echo "fetch-vendor: $f is not in $LOCK" >&2; bad=1; }
  done
  [ "$count" -gt 0 ] || { echo "fetch-vendor: $LOCK lists no file" >&2; exit 1; }
  [ "$bad" -eq 0 ] || exit 1
  echo "fetch-vendor: $count files in $OUT match $LOCK (server $ref)"
  exit 0
fi

REF="$1"
[ -d "$SERVER/.git" ] || [ -f "$SERVER/.git" ] \
  || { echo "fetch-vendor: $SERVER is not a git checkout of the LLeMbas server (set LEMBAS_SERVER)" >&2; exit 1; }
commit="$(git -C "$SERVER" rev-parse --verify --quiet "$REF^{commit}")" \
  || { echo "fetch-vendor: $REF is not a commit in $SERVER" >&2; exit 1; }

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
git -C "$SERVER" show "$commit:$SERVER_LOCK" > "$work/server-lock.json" \
  || { echo "fetch-vendor: $SERVER_LOCK is not in $SERVER at $REF" >&2; exit 1; }
names="$(git -C "$SERVER" ls-tree --name-only "$commit" "$SOURCE/" | sed -n -E 's#^.*/((cm|lezer)-[a-z0-9-]+\.mjs)$#\1#p' | sort)"
[ -n "$names" ] || { echo "fetch-vendor: no CodeMirror modules in $SOURCE at $REF" >&2; exit 1; }

mkdir -p "$work/out"
entries=()
for name in $names; do
  git -C "$SERVER" show "$commit:$SOURCE/$name" > "$work/$name"
  pinned="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get(sys.argv[2], {}).get("sha256", ""))' "$work/server-lock.json" "$name")"
  have="$(sha "$work/$name")"
  [ -n "$pinned" ] || { echo "fetch-vendor: $name is not pinned in the server's $SERVER_LOCK" >&2; exit 1; }
  [ "$pinned" = "$have" ] || { echo "fetch-vendor: $name does not match the server's pin ($have, pinned $pinned)" >&2; exit 1; }
  # "@codemirror/view" -> "./cm-view.mjs", "@lezer/lr" -> "./lezer-lr.mjs", "codemirror" -> "./cm-codemirror.mjs".
  perl -pe 's#\b(from|import)(\s*)"\@codemirror/([a-z-]+)"#$1$2"./cm-$3.mjs"#g; s#\b(from|import)(\s*)"\@lezer/([a-z-]+)"#$1$2"./lezer-$3.mjs"#g; s#\b(from|import)(\s*)"codemirror"#$1$2"./cm-codemirror.mjs"#g' \
    "$work/$name" > "$work/out/$name"
  if grep -E -q '(from|import)\s*"(@codemirror|@lezer)/' "$work/out/$name"; then
    echo "fetch-vendor: a bare module name survived in $name; fix the script" >&2
    exit 1
  fi
  entries+=("$(printf '    "%s": {"server": "%s", "copy": "%s"}' "$name" "$have" "$(sha "$work/out/$name")")")
done
# Every module a copy imports must be one of the copies.
for f in "$work"/out/*.mjs; do
  while read -r dep; do
    [ -f "$work/out/$dep" ] || { echo "fetch-vendor: $(basename "$f") imports $dep, which is not copied" >&2; exit 1; }
  done < <(grep -o -E '(from|import)\s*"\./[a-z0-9-]+\.mjs"' "$f" | sed -E 's/.*"\.\/([^"]+)"/\1/' | sort -u)
done

rm -rf "$OUT"
mkdir -p "$OUT"
cp "$work"/out/*.mjs "$OUT/"
{
  printf '{\n  "tag": "%s",\n  "commit": "%s",\n  "files": {\n' "$REF" "$commit"
  last=$((${#entries[@]} - 1))
  for i in "${!entries[@]}"; do
    if [ "$i" -lt "$last" ]; then printf '%s,\n' "${entries[$i]}"; else printf '%s\n' "${entries[$i]}"; fi
  done
  printf '  }\n}\n'
} > "$LOCK"
echo "fetch-vendor: LLeMbas $REF (${commit:0:12}) $SOURCE -> $OUT (${#entries[@]} files); $LOCK written"
