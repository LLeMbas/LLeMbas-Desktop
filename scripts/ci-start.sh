#!/usr/bin/env bash
# Start the built app on a display without a screen and check it is still running 25 seconds
# later, with nothing in its log saying it stopped. For CI (ci.yml, job `start`):
#
#   scripts/ci-start.sh x11        under Xvfb
#   scripts/ci-start.sh wayland    under a headless Weston, GTK's Wayland backend forced
#
# The app starts with an empty home, so it shows its first-run page and talks to no server.
set -euo pipefail
cd "$(dirname "$0")/.."

APP="${LLEMBAS_DESKTOP_BIN:-src-tauri/target/debug/llembas-desktop}"
[ -x "$APP" ] || { echo "ci-start: no app at $APP; build it first" >&2; exit 1; }
how="${1:?usage: ci-start.sh x11|wayland}"

home="$(mktemp -d)"
runtime="$(mktemp -d)"
chmod 700 "$runtime"
pids=()
cleanup() {
  for p in "${pids[@]}"; do kill "$p" 2>/dev/null || true; done
  rm -rf "$home" "$runtime"
}
trap cleanup EXIT

export HOME="$home" XDG_CONFIG_HOME="$home/.config" XDG_DATA_HOME="$home/.local/share" \
  XDG_STATE_HOME="$home/.local/state" XDG_CACHE_HOME="$home/.cache" XDG_RUNTIME_DIR="$runtime"
# No GPU on a runner: Mesa's software renderer.
export LIBGL_ALWAYS_SOFTWARE=1
log="$XDG_DATA_HOME/eu.llembas.desktop/logs/desktop.log"

case "$how" in
  x11)
    run=(xvfb-run -a -s "-screen 0 1280x840x24")
    ;;
  wayland)
    weston --backend=headless-backend.so --socket=wayland-ci --idle-time=0 --use-pixman \
      > "$runtime/weston.log" 2>&1 &
    pids+=("$!")
    for _ in $(seq 1 50); do
      [ -S "$runtime/wayland-ci" ] && break
      sleep 0.2
    done
    [ -S "$runtime/wayland-ci" ] || { echo "ci-start: weston did not start" >&2; cat "$runtime/weston.log" >&2; exit 1; }
    export WAYLAND_DISPLAY=wayland-ci GDK_BACKEND=wayland
    unset DISPLAY
    run=()
    ;;
  *)
    echo "ci-start: x11 or wayland, not $how" >&2
    exit 2
    ;;
esac

code=0
dbus-run-session -- "${run[@]}" timeout 25 "$APP" > "$runtime/app.log" 2>&1 || code=$?
echo "--- the app's output ($how)"
cat "$runtime/app.log"
if [ -f "$log" ]; then
  echo "--- desktop.log"
  cat "$log"
fi
if [ "$code" -ne 124 ]; then
  echo "ci-start: on $how the app ended by itself within 25 seconds (exit $code)" >&2
  exit 1
fi
if [ -f "$log" ] && grep -q 'stopped:\|could not start\|could not open the window' "$log"; then
  echo "ci-start: on $how the app logged a failure" >&2
  exit 1
fi
echo "ci-start: on $how the app was still running after 25 seconds"
