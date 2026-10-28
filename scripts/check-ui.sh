#!/usr/bin/env bash
# The page's JavaScript parses: the app's modules and the vendored ones as ES modules (a plain
# `node --check file.js` treats a .js file as CommonJS and passes a module with a syntax error in
# it), the generated i18n.js as the classic script it is.
set -euo pipefail
cd "$(dirname "$0")/.."

bad=0
for f in ui/js/*.js ui/vendor/*.mjs; do
  node --input-type=module --check < "$f" || { echo "check-ui: $f does not parse" >&2; bad=1; }
done
node --check ui/i18n.js || { echo "check-ui: ui/i18n.js does not parse" >&2; bad=1; }
# Nothing the page draws is set as HTML: text goes in as text (ui/js/dom.js).
if grep -nE '\.(innerHTML|outerHTML)\s*=|insertAdjacentHTML|document\.write' ui/js/*.js; then
  echo "check-ui: the lines above set HTML from a string" >&2
  bad=1
fi
[ "$bad" -eq 0 ] && echo "check-ui: the page's scripts parse, and none sets HTML"
exit "$bad"
