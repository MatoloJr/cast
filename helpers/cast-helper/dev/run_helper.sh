#!/usr/bin/env bash
# Run the cast helper straight from the repo, on the current session bus.
#
#   ./dev/run_helper.sh                      # real portal + real devices
#   ./dev/run_helper.sh --testsrc            # videotestsrc instead of the screen
#   ./dev/run_helper.sh --testsrc --fake 2   # ... plus 2 ffprobe "receivers"
#   ./dev/run_helper.sh --doctor             # diagnostics only
#
# Stops the installed systemd unit first, because only one process can own the
# bus name. The unit is restarted on exit unless --no-restore is given.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HELPER_DIR="$(dirname "$HERE")"
VENV="${XDG_DATA_HOME:-$HOME/.local/share}/cast-display/cast-helper/venv"
PYTHON="$VENV/bin/python"

RESTORE=1
DOCTOR=0
ARGS=()
export CAST_HELPER_LOG="${CAST_HELPER_LOG:-debug}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --testsrc)    export CAST_HELPER_TEST_SOURCE=1 ;;
    --fake)       export CAST_HELPER_FAKE_DEVICES="${2:?--fake needs a count}"; shift ;;
    --no-restore) RESTORE=0 ;;
    --doctor)     DOCTOR=1; ARGS+=("--doctor") ;;
    *)            ARGS+=("$1") ;;
  esac
  shift
done

if [[ ! -x "$PYTHON" ]]; then
  echo "No helper venv at $VENV — run ./install.sh --helper-only first." >&2
  echo "Falling back to system python3 (pychromecast may be missing)." >&2
  PYTHON="$(command -v python3)"
fi

if [[ "$DOCTOR" -eq 1 ]]; then
  exec "$PYTHON" "$HELPER_DIR/cast_helper.py" "${ARGS[@]}"
fi

WAS_ACTIVE=0
if systemctl --user is-active --quiet cast-helper.service 2>/dev/null; then
  WAS_ACTIVE=1
  echo "==> Stopping installed cast-helper.service"
  systemctl --user stop cast-helper.service
fi

cleanup() {
  if [[ "$RESTORE" -eq 1 && "$WAS_ACTIVE" -eq 1 ]]; then
    echo
    echo "==> Restarting installed cast-helper.service"
    systemctl --user start cast-helper.service || true
  fi
}
trap cleanup EXIT

echo "==> Running helper from $HELPER_DIR (log=$CAST_HELPER_LOG)"
[[ -n "${CAST_HELPER_TEST_SOURCE:-}" ]] && echo "    test source: on"
[[ -n "${CAST_HELPER_FAKE_DEVICES:-}" ]] && echo "    fake receivers: $CAST_HELPER_FAKE_DEVICES"
exec "$PYTHON" "$HELPER_DIR/cast_helper.py" "${ARGS[@]}"
