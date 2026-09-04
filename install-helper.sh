#!/usr/bin/env bash
# Install Cast Display helper (Python venv + systemd --user unit + D-Bus activation).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HELPER_SRC="$ROOT/helpers/cast-helper"
INSTALL_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/cast-display/cast-helper"
UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
DBUS_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/dbus-1/services"

echo "==> Installing Cast Display helper to $INSTALL_DIR"

mkdir -p "$INSTALL_DIR" "$UNIT_DIR" "$DBUS_DIR"

# System packages (best-effort; may need sudo)
need_pkgs=()
for pkg in python3-venv python3-gi python3-dbus \
           gir1.2-gstreamer-1.0 gstreamer1.0-tools \
           gstreamer1.0-plugins-base gstreamer1.0-plugins-good \
           gstreamer1.0-plugins-ugly gstreamer1.0-pipewire; do
  if ! dpkg -s "$pkg" >/dev/null 2>&1; then
    need_pkgs+=("$pkg")
  fi
done

if ((${#need_pkgs[@]})); then
  echo "==> Missing packages: ${need_pkgs[*]}"
  if [[ -t 0 ]] && command -v sudo >/dev/null 2>&1; then
    sudo apt-get update
    sudo apt-get install -y "${need_pkgs[@]}"
  else
    echo "WARNING: cannot install system packages non-interactively."
    echo "Run: sudo apt-get install -y ${need_pkgs[*]}"
    echo "Continuing with Python venv install…"
  fi
fi

# Optional VA-API encoder (ignored if unavailable)
if ! dpkg -s gstreamer1.0-vaapi >/dev/null 2>&1; then
  echo "==> Optional: sudo apt-get install -y gstreamer1.0-vaapi  (hardware H.264)"
fi

cp -f "$HELPER_SRC/cast_helper.py" "$INSTALL_DIR/cast_helper.py"
cp -f "$HELPER_SRC/requirements.txt" "$INSTALL_DIR/requirements.txt"
chmod +x "$INSTALL_DIR/cast_helper.py"

if [[ ! -d "$INSTALL_DIR/venv" ]]; then
  python3 -m venv --system-site-packages "$INSTALL_DIR/venv"
fi
# shellcheck disable=SC1091
source "$INSTALL_DIR/venv/bin/activate"
pip install --upgrade pip
pip install -r "$INSTALL_DIR/requirements.txt"
deactivate

# systemd user unit with absolute paths
PYTHON="$INSTALL_DIR/venv/bin/python"
SCRIPT="$INSTALL_DIR/cast_helper.py"
cat > "$UNIT_DIR/cast-helper.service" <<EOF
[Unit]
Description=Cast Display Chromecast helper
PartOf=graphical-session.target

[Service]
Type=dbus
BusName=org.cast.tools.Cast1
ExecStart=$PYTHON $SCRIPT
Restart=on-failure
RestartSec=2
Environment=PYTHONUNBUFFERED=1

[Install]
WantedBy=default.target
EOF

# D-Bus activation → systemd user unit
cat > "$DBUS_DIR/org.cast.tools.Cast1.service" <<EOF
[D-BUS Service]
Name=org.cast.tools.Cast1
Exec=/bin/false
SystemdService=cast-helper.service
EOF

systemctl --user daemon-reload
systemctl --user enable --now cast-helper.service

echo
echo "Helper installed and started."
echo "  Status:  systemctl --user status cast-helper.service"
echo "  Logs:    journalctl --user -u cast-helper.service -f"
echo "  Test:    gdbus call --session -d org.cast.tools.Cast1 -o /org/cast/tools/Cast1 -m org.cast.tools.Cast1.ListDevices"
echo
echo "Note: Chromecast must reach this PC on the LAN. Allow the ephemeral HTTP"
echo "port (or your firewall) when casting. Audio is not cast in Phase 2."
