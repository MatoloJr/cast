#!/usr/bin/env bash
# Load the extension into a throwaway GNOME Shell, with the dev helper and
# report anything the Shell complains about.
#
#   ./run_nested_shell.sh            # headless, for CI and for a quick check
#   ./run_nested_shell.sh --devkit   # a window you can actually click in
#
# Both the Shell and the helper run on a private session bus, so this cannot
# disturb the real desktop or fight it for the org.gnome.Shell name.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HELPER_DIR="$(dirname "$HERE")"
REPO="$(cd "$HELPER_DIR/../.." && pwd)"
UUID="display-and-cast@cast.tools"
VENV="${XDG_DATA_HOME:-$HOME/.local/share}/cast-display/cast-helper/venv"
PYTHON="$VENV/bin/python"

MODE=headless
SECONDS_TO_RUN=25
for arg in "$@"; do
  case "$arg" in
    --devkit)   MODE=devkit ;;
    --headless) MODE=headless ;;
    --seconds=*) SECONDS_TO_RUN="${arg#*=}" ;;
  esac
done

WORK="$(mktemp -d -t cast-nested-XXXXXX)"
SHELL_LOG="$WORK/shell.log"
HELPER_LOG="$WORK/helper.log"
trap 'rm -rf "$WORK"' EXIT

echo "==> building schemas"
glib-compile-schemas "$REPO/schemas/"

# Install into a throwaway XDG_DATA_HOME, so the test always exercises THIS
# repo and never reads or rewrites whatever the real desktop has installed.
# (The first version of this script reused the user's extension directory and
# silently tested a stale second checkout for several runs.)
PRIVATE_DATA="$WORK/data"
EXT_DIR="$PRIVATE_DATA/gnome-shell/extensions/$UUID"
mkdir -p "$(dirname "$EXT_DIR")"
ln -sfn "$REPO" "$EXT_DIR"
echo "    testing $REPO via $EXT_DIR"

if [[ "$MODE" == headless ]]; then
  SHELL_ARGS=(--headless --virtual-monitor 1920x1080 --wayland --no-x11)
else
  SHELL_ARGS=(--devkit)
fi

echo "==> starting a private bus, the helper and gnome-shell ($MODE)"
cat >"$WORK/inner.sh" <<INNER
set -euo pipefail

# Private data dir first on the search path and the system dirs after it so
# the Shell still finds its own resources.
export XDG_DATA_HOME="$PRIVATE_DATA"
export XDG_DATA_DIRS="\${XDG_DATA_DIRS:-/usr/local/share:/usr/share}"

export CAST_HELPER_LOG=debug
export CAST_HELPER_TEST_SOURCE=1
export CAST_HELPER_FAKE_DEVICES=2
export PYTHONPATH="$HELPER_DIR"
"$PYTHON" -m cast_helper >"$HELPER_LOG" 2>&1 &
HELPER_PID=\$!

# Let the helper own the bus name before the Shell's client looks for it.
for _ in \$(seq 40); do
  gdbus call --session -d org.cast.tools.Cast1 -o /org/cast/tools/Cast1 \
    -m org.freedesktop.DBus.Properties.Get org.cast.tools.Cast1 ApiVersion \
    >/dev/null 2>&1 && break
  sleep 0.25
done

export MUTTER_DEBUG_DUMMY_MODE_SPECS=1920x1080
gnome-shell ${SHELL_ARGS[*]} >"$SHELL_LOG" 2>&1 &
SHELL_PID=\$!

sleep 8

# The Shell only auto-enables extensions listed as enabled.
gsettings set org.gnome.shell disable-user-extensions false || true
# Enable ONLY the extension under test, so another installed extension's
# warnings cannot be mistaken for ours.
gsettings set org.gnome.shell enabled-extensions "['$UUID']" || true
gnome-extensions enable "$UUID" || true
sleep 5
echo "--- extension info ---"
gnome-extensions info "$UUID" || true
echo "--- helper state as the extension sees it ---"
gdbus call --session -d org.cast.tools.Cast1 -o /org/cast/tools/Cast1 \
  -m org.freedesktop.DBus.Properties.Get org.cast.tools.Cast1 State || true

# Drive a full cast lifecycle while the extension is loaded, so its sync
# paths run against real Devices/Sessions/Streams data rather than an idle
# helper. Any actor misuse shows up as a critical in the Shell log.
echo "--- scripted lifecycle ---"
IDS=\$(gdbus call --session -d org.cast.tools.Cast1 -o /org/cast/tools/Cast1 \
  -m org.freedesktop.DBus.Properties.Get org.cast.tools.Cast1 Devices \
  | grep -oE "fake:[0-9a-f-]+")
FIRST=\$(echo "\$IDS" | head -1)
SECOND=\$(echo "\$IDS" | tail -1)

echo "StartCast -> \$FIRST"
STREAM=\$(gdbus call --session -d org.cast.tools.Cast1 -o /org/cast/tools/Cast1 \
  -m org.cast.tools.Cast1.StartCast "['\$FIRST']" "{}" \
  | sed -nE "s/.*'([0-9a-f]+)'.*/\\1/p")
echo "  stream=\$STREAM"
sleep 6
echo "  State: \$(gdbus call --session -d org.cast.tools.Cast1 -o /org/cast/tools/Cast1 -m org.freedesktop.DBus.Properties.Get org.cast.tools.Cast1 State)"

echo "AddDevices -> \$SECOND"
gdbus call --session -d org.cast.tools.Cast1 -o /org/cast/tools/Cast1 \
  -m org.cast.tools.Cast1.AddDevices "\$STREAM" "['\$SECOND']" >/dev/null || true
sleep 6
echo "  Sessions: \$(gdbus call --session -d org.cast.tools.Cast1 -o /org/cast/tools/Cast1 -m org.freedesktop.DBus.Properties.Get org.cast.tools.Cast1 Sessions | grep -oE "'state': <'[a-z]+'>" | tr '\\n' ' ')"

echo "RemoveDevice -> \$SECOND"
gdbus call --session -d org.cast.tools.Cast1 -o /org/cast/tools/Cast1 \
  -m org.cast.tools.Cast1.RemoveDevice "\$SECOND" >/dev/null || true
sleep 2

echo "Simulating a screen lock (extension disable/enable)"
gnome-extensions disable "$UUID" || true
sleep 2
gnome-extensions enable "$UUID" || true
sleep 3
echo "  State after relock: \$(gdbus call --session -d org.cast.tools.Cast1 -o /org/cast/tools/Cast1 -m org.freedesktop.DBus.Properties.Get org.cast.tools.Cast1 State)"

echo "StopAll"
gdbus call --session -d org.cast.tools.Cast1 -o /org/cast/tools/Cast1 \
  -m org.cast.tools.Cast1.StopAll >/dev/null || true
sleep 2
echo "  State: \$(gdbus call --session -d org.cast.tools.Cast1 -o /org/cast/tools/Cast1 -m org.freedesktop.DBus.Properties.Get org.cast.tools.Cast1 State)"

sleep 3

kill \$SHELL_PID 2>/dev/null || true
kill \$HELPER_PID 2>/dev/null || true
wait 2>/dev/null || true
INNER
chmod +x "$WORK/inner.sh"

# Run via systemd-run so the Shell gets the user session's environment.
# Inside a snap-confined terminal (the VS Code snap, for instance) the snap's
# library paths leak in and xdg-desktop-portal dies with a libpthread symbol
# error, which also takes down GNOME's own Extensions service. systemd --user
# hands us a clean environment.
RUNNER=(dbus-run-session -- "$WORK/inner.sh")
if command -v systemd-run >/dev/null && [[ -n "${SNAP:-}" ]]; then
  echo "    (snap environment detected; running via systemd-run for a clean env)"
  RUNNER=(systemd-run --user --pipe --quiet --wait --setenv=HOME="$HOME" \
          dbus-run-session -- "$WORK/inner.sh")
fi
"${RUNNER[@]}" || echo "    (inner script exited non-zero)"

echo
echo "==> gnome-shell messages about this extension"
if grep -qiE "display-and-cast|cast.tools" "$SHELL_LOG" 2>/dev/null; then
  grep -iE "display-and-cast|cast.tools" "$SHELL_LOG" | sed 's/^/    /'
else
  echo "    (none)"
fi

echo
echo "==> warnings and errors in gnome-shell"
if grep -qiE "\b(WARNING|CRITICAL|ERROR|Traceback|JS ERROR)\b" "$SHELL_LOG" 2>/dev/null; then
  grep -iE "\b(WARNING|CRITICAL|ERROR|Traceback|JS ERROR)\b" "$SHELL_LOG" \
    | grep -viE "Failed to (open|load) module|No GSettings schemas|gvfs|libEGL|MESA|dbus-daemon|Could not determine|gnome-session" \
    | head -30 | sed 's/^/    /'
else
  echo "    (none)"
fi

echo
echo "==> helper log tail"
tail -n 12 "$HELPER_LOG" 2>/dev/null | sed 's/^/    /' || echo "    (no helper log)"

cp "$SHELL_LOG" /tmp/cast-nested-shell.log 2>/dev/null || true
cp "$HELPER_LOG" /tmp/cast-nested-helper.log 2>/dev/null || true
echo
echo "full logs: /tmp/cast-nested-shell.log /tmp/cast-nested-helper.log"
