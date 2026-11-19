#!/usr/bin/env bash
# Put the server's vendored CodeMirror build and xterm where the app's own pages read them from:
#   ui/vendor/*.mjs   (copies of the server's static/vendor/cm-*.mjs and lezer-*.mjs)
#   ui/vendor/xterm.js, xterm.css, xterm-addon-fit.js   (the terminal panel's, copied unchanged:
#                     classic scripts the panel loads when it is first opened)
#   src-tauri/viewers/   the server's sealed viewers for a PDF and a 3D model, copied unchanged:
#                     its page (shell.html, out of api/tree.py), its two scripts (sealed-pdf.js,
#                     sealed-model.js) and the PDF.js it vendors (pdf.min.mjs, pdf.worker.min.mjs,
#                     with its licence). They are NOT part of ui/: Rust compiles them in and
#                     serves them only to a sealed frame (src-tauri/src/sealed.rs), so the
#                     library that parses somebody's file is never a script of the app's page.
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
# are rewritten to the sibling files ("./cm-view.mjs"), and nothing else is touched. esm.sh's
# Node polyfill ("/node/process.mjs", which @lezer/lr imports to read process.env.LOG) becomes
# "./node-process.mjs", the server's own one-line stub (static/js/node-process.mjs), copied too:
# an absolute path is a 404 in the app, and a failed @lezer/lr takes every editor language with it.
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
VIEWERS="src-tauri/viewers"
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
  done < <(sed -n -E 's/^ *"([a-z0-9-]+\.(mjs|js|css))": *\{"server": *"[0-9a-f]{64}", *"copy": *"([0-9a-f]{64})"\}.*/\1\t\3/p' "$LOCK")
  for f in "$OUT"/*; do
    grep -q "\"$(basename "$f")\"" "$LOCK" || { echo "fetch-vendor: $f is not in $LOCK" >&2; bad=1; }
  done
  [ "$count" -gt 0 ] || { echo "fetch-vendor: $LOCK lists no file" >&2; exit 1; }
  # The sealed viewers: "viewers/name": {"server": "…", "copy": "…"}
  viewers=0
  while IFS=$'\t' read -r name want; do
    viewers=$((viewers + 1))
    if [ ! -f "$VIEWERS/$name" ]; then
      echo "fetch-vendor: $VIEWERS/$name is missing" >&2
      bad=1
    elif [ "$(sha "$VIEWERS/$name")" != "$want" ]; then
      echo "fetch-vendor: $VIEWERS/$name does not match $LOCK (server $ref)" >&2
      bad=1
    fi
  done < <(sed -n -E 's/^ *"viewers\/([A-Za-z0-9.-]+)": *\{"server": *"[0-9a-f]{64}", *"copy": *"([0-9a-f]{64})"\}.*/\1\t\2/p' "$LOCK")
  for f in "$VIEWERS"/*; do
    grep -q "\"viewers/$(basename "$f")\"" "$LOCK" || { echo "fetch-vendor: $f is not in $LOCK" >&2; bad=1; }
  done
  [ "$viewers" -gt 0 ] || { echo "fetch-vendor: $LOCK lists no viewer" >&2; exit 1; }
  [ "$bad" -eq 0 ] || exit 1
  echo "fetch-vendor: $count files in $OUT and $viewers in $VIEWERS match $LOCK (server $ref)"
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
  perl -pe 's#\b(from|import)(\s*)"\@codemirror/([a-z-]+)"#$1$2"./cm-$3.mjs"#g; s#\b(from|import)(\s*)"\@lezer/([a-z-]+)"#$1$2"./lezer-$3.mjs"#g; s#\b(from|import)(\s*)"codemirror"#$1$2"./cm-codemirror.mjs"#g; s#\b(from|import)(\s*)"/node/process\.mjs"#$1$2"./node-process.mjs"#g' \
    "$work/$name" > "$work/out/$name"
  if grep -E -q '(from|import)\s*"((@codemirror|@lezer)/|/)' "$work/out/$name"; then
    echo "fetch-vendor: a bare module name or an absolute path survived in $name; fix the script" >&2
    exit 1
  fi
  entries+=("$(printf '    "%s": {"server": "%s", "copy": "%s"}' "$name" "$have" "$(sha "$work/out/$name")")")
done
# xterm and its fit addon, for the terminal panel: copied as they are, each checked against the
# server's pin like the modules.
for name in xterm.js xterm.css xterm-addon-fit.js; do
  git -C "$SERVER" show "$commit:$SOURCE/$name" > "$work/out/$name" \
    || { echo "fetch-vendor: $name is not in $SOURCE at $REF" >&2; exit 1; }
  pinned="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get(sys.argv[2], {}).get("sha256", ""))' "$work/server-lock.json" "$name")"
  have="$(sha "$work/out/$name")"
  [ "$pinned" = "$have" ] || { echo "fetch-vendor: $name does not match the server's pin ($have, pinned $pinned)" >&2; exit 1; }
  entries+=("$(printf '    "%s": {"server": "%s", "copy": "%s"}' "$name" "$have" "$have")")
done
# The polyfill stub, from the server's own scripts (it is not a download, so it has no pin there).
stub="src/lembas/web/static/js/node-process.mjs"
git -C "$SERVER" show "$commit:$stub" > "$work/out/node-process.mjs" \
  || { echo "fetch-vendor: $stub is not in $SERVER at $REF" >&2; exit 1; }
entries+=("$(printf '    "%s": {"server": "%s", "copy": "%s"}' node-process.mjs "$(sha "$work/out/node-process.mjs")" "$(sha "$work/out/node-process.mjs")")")
# The sealed viewers (a PDF, a 3D model), as the server serves them at /files/viewer/{kind}:
# PDF.js checked against the server's pin; the server's own page and scripts have none there.
mkdir -p "$work/viewers"
for name in pdf.min.mjs pdf.worker.min.mjs pdfjs-LICENSE.txt; do
  git -C "$SERVER" show "$commit:$SOURCE/$name" > "$work/viewers/$name" \
    || { echo "fetch-vendor: $name is not in $SOURCE at $REF" >&2; exit 1; }
  pinned="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get(sys.argv[2], {}).get("sha256", ""))' "$work/server-lock.json" "$name")"
  have="$(sha "$work/viewers/$name")"
  [ "$pinned" = "$have" ] || { echo "fetch-vendor: $name does not match the server's pin ($have, pinned $pinned)" >&2; exit 1; }
  entries+=("$(printf '    "viewers/%s": {"server": "%s", "copy": "%s"}' "$name" "$have" "$have")")
done
for name in sealed-pdf.js sealed-model.js; do
  git -C "$SERVER" show "$commit:src/lembas/web/static/js/$name" > "$work/viewers/$name" \
    || { echo "fetch-vendor: $name is not among the server's scripts at $REF" >&2; exit 1; }
  have="$(sha "$work/viewers/$name")"
  entries+=("$(printf '    "viewers/%s": {"server": "%s", "copy": "%s"}' "$name" "$have" "$have")")
done
# The page the two scripts are written into: the server keeps it as a string (`_VIEWER_SHELL`),
# read out of its source as Python reads it, with the place for the script left as it is.
git -C "$SERVER" show "$commit:src/lembas/api/tree.py" > "$work/tree.py" \
  || { echo "fetch-vendor: src/lembas/api/tree.py is not in $SERVER at $REF" >&2; exit 1; }
python3 - "$work/tree.py" "$work/viewers/shell.html" <<'PY'
import ast, sys
tree = ast.parse(open(sys.argv[1], encoding="utf-8").read())
for node in tree.body:
    if isinstance(node, ast.Assign) and any(getattr(t, "id", "") == "_VIEWER_SHELL" for t in node.targets):
        shell = ast.literal_eval(node.value)
        if shell.count("/*SCRIPT*/") != 1:
            sys.exit("fetch-vendor: the viewer's page has no one place for its script")
        open(sys.argv[2], "w", encoding="utf-8").write(shell)
        break
else:
    sys.exit("fetch-vendor: _VIEWER_SHELL is not in the server's api/tree.py")
PY
have="$(sha "$work/viewers/shell.html")"
entries+=("$(printf '    "viewers/%s": {"server": "%s", "copy": "%s"}' shell.html "$have" "$have")")

# Every module a copy imports must be one of the copies.
for f in "$work"/out/*.mjs; do
  while read -r dep; do
    [ -f "$work/out/$dep" ] || { echo "fetch-vendor: $(basename "$f") imports $dep, which is not copied" >&2; exit 1; }
  done < <(grep -o -E '(from|import)\s*"\./[a-z0-9-]+\.mjs"' "$f" | sed -E 's/.*"\.\/([^"]+)"/\1/' | sort -u)
done

rm -rf "$OUT"
mkdir -p "$OUT"
cp "$work"/out/*.mjs "$work"/out/xterm.js "$work"/out/xterm.css "$work"/out/xterm-addon-fit.js "$OUT/"
rm -rf "$VIEWERS"
mkdir -p "$VIEWERS"
cp "$work"/viewers/* "$VIEWERS/"
{
  printf '{\n  "tag": "%s",\n  "commit": "%s",\n  "files": {\n' "$REF" "$commit"
  last=$((${#entries[@]} - 1))
  for i in "${!entries[@]}"; do
    if [ "$i" -lt "$last" ]; then printf '%s,\n' "${entries[$i]}"; else printf '%s\n' "${entries[$i]}"; fi
  done
  printf '  }\n}\n'
} > "$LOCK"
echo "fetch-vendor: LLeMbas $REF (${commit:0:12}) $SOURCE -> $OUT (${#entries[@]} files); $LOCK written"
