#!/usr/bin/env bash
# The repository is public: nothing in it may name the private estate it was written on.
# The LLeMbas section rule ("everything public is current-state and estate-free"), as a check
# that runs in CI on every push rather than a sentence somebody has to remember.
#
# Patterns are the kinds of thing that leak: a private domain, an internal `.lan` name, a
# container number, a private address range, a machine's name. This file is the one place that
# may spell them, and is skipped.
set -euo pipefail
cd "$(dirname "$0")/.."

patterns=(
  'houmeres'
  '\b[a-z0-9-]+\.lan\b'
  '\bCT ?2[0-9]{2}\b'
  '\b10\.0\.0\.[0-9]+'
  '\b192\.168\.[0-9]+\.[0-9]+'
  '\bgamebox\b'
  '\bthor\b'
)
found=0
for pattern in "${patterns[@]}"; do
  if git ls-files -z | grep -zv '^scripts/hygiene.sh$' | xargs -0 grep -nIEi -- "$pattern" ; then
    echo "hygiene: the lines above match /$pattern/" >&2
    found=1
  fi
done
[ "$found" -eq 0 ] && echo "hygiene: nothing private in the tracked files"
exit "$found"
