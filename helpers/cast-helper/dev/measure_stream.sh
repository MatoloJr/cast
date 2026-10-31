#!/usr/bin/env bash
# Measure what the stream actually costs and how far behind live it runs.
#
#   ./measure_stream.sh [WxH@fps]      default 1920x1080@30
#
# Reports:
#   * time to first decodable frame, as a client sees it
#   * lag behind live: wall-clock elapsed minus the newest delivered PTS.
#     A live stream that is not accumulating delay keeps this small; it is
#     the part of glass-to-glass latency this machine is responsible for.
#   * CPU and RSS of the helper while streaming.
set -euo pipefail

SIZE="${1:-1920x1080@30}"
# Second argument caps the encode height. Without it the helper picks its own
# default, which is 720 on a machine with no hardware encoder.
MAX_HEIGHT="${2:-}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HELPER_DIR="$(dirname "$HERE")"
VENV="${XDG_DATA_HOME:-$HOME/.local/share}/cast-display/cast-helper/venv"
PYTHON="$VENV/bin/python"
BUS=org.cast.tools.Cast1
OBJ=/org/cast/tools/Cast1
LOG="$(mktemp -t cast-measure-XXXXXX.log)"

cleanup() {
  [[ -n "${HELPER_PID:-}" ]] && kill "$HELPER_PID" 2>/dev/null || true
  wait "${HELPER_PID:-}" 2>/dev/null || true
}
trap cleanup EXIT

WAS_ACTIVE=0
if systemctl --user is-active --quiet cast-helper.service 2>/dev/null; then
  WAS_ACTIVE=1
  systemctl --user stop cast-helper.service
fi
restore() { [[ "$WAS_ACTIVE" -eq 1 ]] && systemctl --user start cast-helper.service || true; }
trap 'cleanup; restore' EXIT

echo "==> helper with test source $SIZE"
CAST_HELPER_LOG=info \
CAST_HELPER_TEST_SOURCE=1 \
CAST_HELPER_TEST_SIZE="$SIZE" \
CAST_HELPER_FAKE_DEVICES=1 \
PYTHONPATH="$HELPER_DIR" \
  "$PYTHON" -m cast_helper >"$LOG" 2>&1 &
HELPER_PID=$!

# Careful: merely calling the bus name D-Bus-activates the *installed* unit
# (org.cast.tools.Cast1.service has SystemdService=cast-helper.service), which
# would then own the name instead of the helper we just started. So wait until
# the name's owner really is our process.
owner_pid() {
  gdbus call --session -d org.freedesktop.DBus -o /org/freedesktop/DBus \
    -m org.freedesktop.DBus.GetConnectionUnixProcessID "$BUS" 2>/dev/null \
    | sed -nE 's/.*uint32 ([0-9]+).*/\1/p' 
}
for _ in $(seq 60); do
  if [[ "$(owner_pid)" == "$HELPER_PID" ]]; then break; fi
  sleep 0.25
done
if [[ "$(owner_pid)" != "$HELPER_PID" ]]; then
  echo "the bus name is owned by $(owner_pid), not our helper ($HELPER_PID)." >&2
  echo "Stop the installed unit first: systemctl --user stop cast-helper.service" >&2
  cat "$LOG" >&2
  exit 1
fi

DEVICE=$(gdbus call --session -d $BUS -o $OBJ \
  -m org.freedesktop.DBus.Properties.Get $BUS Devices \
  | grep -oE "fake:[0-9a-f-]+" | head -1)
[[ -z "$DEVICE" ]] && { echo "no fake device appeared"; cat "$LOG"; exit 1; }

echo "==> StartCast"
START_EPOCH=$(date +%s.%N)
OPTS="{}"
if [[ -n "$MAX_HEIGHT" ]]; then
  OPTS="{'max_height': <uint32 $MAX_HEIGHT>}"
fi
echo "    options: $OPTS"
gdbus call --session -d $BUS -o $OBJ -m $BUS.StartCast "['$DEVICE']" "$OPTS" >/dev/null
sleep 3

PATH_PART=$(grep -oE "GET /s/[^ ]+" "$LOG" | tail -1 | cut -d' ' -f2)
PORT=$(grep -oE "listening on port [0-9]+" "$LOG" | tail -1 | grep -oE "[0-9]+")
URL="http://127.0.0.1:$PORT$PATH_PART"
echo "    $URL"

echo
echo "==> time to first decodable frame"
T0=$(date +%s.%N)
FIRST=$(ffprobe -v error -select_streams v:0 -show_entries frame=pkt_pts_time \
          -read_intervals "%+1" -of csv=p=0 "$URL" 2>/dev/null | head -1 || true)
T1=$(date +%s.%N)
echo "    $(awk -v a="$T0" -v b="$T1" 'BEGIN{printf "%.2f s", b-a}') (first frame pts=${FIRST:-?})"

echo
echo "==> CPU / RSS while streaming (5 samples, 2 s apart)"
printf "    %-8s %-8s %-10s\n" "%CPU" "%MEM" "RSS"
for _ in $(seq 5); do
  sleep 2
  ps -o %cpu=,%mem=,rss= -p "$HELPER_PID" | awk '{printf "    %-8s %-8s %-10s\n", $1, $2, $3"k"}'
done

echo
echo "==> lag behind live"
# PTS is measured from the pipeline's start, not from when a client connects,
# so the comparison has to be against the pipeline's own elapsed run time.
PIPELINE_START=$(grep -m1 "pipeline started" "$LOG" | cut -d' ' -f1-2)
PIPELINE_EPOCH=$(date -d "$PIPELINE_START" +%s.%N 2>/dev/null || echo "")
LAST_PTS=$(timeout 10 ffprobe -v error -select_streams v:0 \
             -show_entries packet=pts_time -of csv=p=0 "$URL" 2>/dev/null \
             | grep -oE "[0-9]+\.[0-9]+" | tail -1 || true)
NOW_EPOCH=$(date +%s.%N)
if [[ -n "$LAST_PTS" && -n "$PIPELINE_EPOCH" ]]; then
  awk -v now="$NOW_EPOCH" -v start="$PIPELINE_EPOCH" -v pts="$LAST_PTS" \
    'BEGIN{
       elapsed = now - start;
       printf "    pipeline running %.1fs, newest delivered PTS %.2fs\n", elapsed, pts;
       printf "    lag behind live: %.2f s\n", elapsed - pts;
     }'
else
  echo "    could not measure (pts=${LAST_PTS:-none} start=${PIPELINE_EPOCH:-none})"
fi

echo
echo "==> pipeline"
grep -E "pipeline:" "$LOG" | tail -1 | sed 's/^.*pipeline: /    /'
grep -E "encoder .* verified|fell back|pipeline started" "$LOG" | tail -2 | sed 's/^.*: /    /'

gdbus call --session -d $BUS -o $OBJ -m $BUS.StopAll >/dev/null 2>&1 || true
echo
echo "log: $LOG"
