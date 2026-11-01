#!/usr/bin/env bash
# Cast Display one-command install (extension + cast helper).
# Usage:
#   ./install.sh              # full install
#   ./install.sh --helper-only
#   ./install.sh --uninstall
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
UUID="display-and-cast@cast.tools"
EXT_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/gnome-shell/extensions/$UUID"
HELPER_SRC="$ROOT/helpers/cast-helper"
INSTALL_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/cast-display/cast-helper"
UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
DBUS_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/dbus-1/services"

HELPER_ONLY=0
UNINSTALL=0
for arg in "$@"; do
  case "$arg" in
    --helper-only) HELPER_ONLY=1 ;;
    --uninstall) UNINSTALL=1 ;;
    -h|--help)
      echo "Usage: $0 [--helper-only|--uninstall]"
      exit 0
      ;;
  esac
done

STATE_DIR="${XDG_STATE_HOME:-$HOME/.local/state}/cast-display"

uninstall_all() {
  echo "==> Uninstalling Cast Display"
  gnome-extensions disable "$UUID" 2>/dev/null || true
  systemctl --user disable --now cast-helper.service 2>/dev/null || true
  rm -f "$UNIT_DIR/cast-helper.service"
  rm -f "$DBUS_DIR/org.cast.tools.Cast1.service"
  rm -rf "${XDG_DATA_HOME:-$HOME/.local/share}/cast-display"
  rm -rf "${XDG_RUNTIME_DIR:-/tmp}/cast-display"

  # The saved screen-share restore token lives here. Removing it means the
  # portal will ask for permission again after a reinstall, which is the
  # right default for an uninstall.
  if [[ -d "$STATE_DIR" ]]; then
    rm -rf "$STATE_DIR"
    echo "    Removed saved screen-share permission ($STATE_DIR)"
  fi

  if [[ -L "$EXT_DIR" || -d "$EXT_DIR" ]]; then
    rm -rf "$EXT_DIR"
  fi
  systemctl --user daemon-reload 2>/dev/null || true

  remove_firewall_rule
  echo "Done. Log out and back in on Wayland to finish unloading the extension."
}

# -- firewall --------------------------------------------------------------

PORT_MIN=8765
PORT_MAX=8775

lan_subnet() {
  ip -o -f inet addr show scope global 2>/dev/null \
    | awk '{print $4}' \
    | grep -vE '^(172\.1[6-9]|172\.2[0-9]|172\.3[01])\.' \
    | head -1
}

offer_firewall_rule() {
  command -v ufw >/dev/null 2>&1 || return 0
  # `ufw status` needs root; if we cannot read it, say so rather than guess.
  local status
  if ! status="$(sudo -n ufw status 2>/dev/null)"; then
    echo "==> Firewall: could not read ufw status without a password."
    echo "    If ufw is active, the receivers need this port range opened:"
    print_firewall_command
    return 0
  fi
  if ! grep -q "Status: active" <<<"$status"; then
    echo "==> Firewall: ufw is installed but inactive; nothing to open."
    return 0
  fi
  if grep -q "$PORT_MIN:$PORT_MAX" <<<"$status"; then
    echo "==> Firewall: the Cast Display rule is already present."
    return 0
  fi

  echo "==> Firewall: ufw is active, so receivers cannot reach the stream."
  print_firewall_command
  if [[ ! -t 0 ]]; then
    echo "    Not a terminal, so not changing the firewall. Run the command above."
    return 0
  fi
  read -r -p "    Add this rule now? [y/N] " answer
  if [[ "${answer,,}" == "y" ]]; then
    local subnet
    subnet="$(lan_subnet)"
    sudo ufw allow from "${subnet:-192.168.0.0/16}" to any \
      port "$PORT_MIN:$PORT_MAX" proto tcp comment 'Cast Display' \
      && echo "    Rule added." || echo "    Could not add the rule."
  else
    echo "    Skipped."
  fi
}

print_firewall_command() {
  local subnet
  subnet="$(lan_subnet)"
  echo "      sudo ufw allow from ${subnet:-192.168.0.0/16} to any \\"
  echo "        port $PORT_MIN:$PORT_MAX proto tcp comment 'Cast Display'"
}

remove_firewall_rule() {
  command -v ufw >/dev/null 2>&1 || return 0
  sudo -n ufw status 2>/dev/null | grep -q "Cast Display" || return 0
  echo "==> A ufw rule for Cast Display is still present."
  echo "      sudo ufw delete allow from any to any port $PORT_MIN:$PORT_MAX proto tcp"
  if [[ -t 0 ]]; then
    read -r -p "    Remove it now? [y/N] " answer
    if [[ "${answer,,}" == "y" ]]; then
      sudo ufw --force delete allow "$PORT_MIN:$PORT_MAX/tcp" \
        >/dev/null 2>&1 || true
      echo "    Removed (verify with: sudo ufw status)."
    fi
  fi
}

install_helper() {
  echo "==> Installing cast helper → $INSTALL_DIR"
  mkdir -p "$INSTALL_DIR" "$UNIT_DIR" "$DBUS_DIR"

  need_pkgs=()
  # gstreamer1.0-plugins-bad provides h264parse, mpegtsmux and the VA
  # encoders; without it the pipeline cannot be built at all (defect F5).
  # python3-dbus is gone: the helper uses Gio's GDBus only.
  for pkg in python3-venv python3-gi ffmpeg \
             gir1.2-gstreamer-1.0 gstreamer1.0-tools \
             gstreamer1.0-plugins-base gstreamer1.0-plugins-good \
             gstreamer1.0-plugins-bad gstreamer1.0-plugins-ugly \
             gstreamer1.0-libav gstreamer1.0-pipewire; do
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
      echo "WARNING: run: sudo apt-get install -y ${need_pkgs[*]}"
    fi
  fi

  if ! command -v gnome-network-displays >/dev/null 2>&1; then
    echo "==> Optional (Miracast / Windows-like wireless display):"
    echo "    sudo apt-get install -y gnome-network-displays"
  fi

  if ! dpkg -s gstreamer1.0-vaapi >/dev/null 2>&1; then
    echo "==> Optional (HW H.264): sudo apt-get install -y gstreamer1.0-vaapi"
  fi

  rm -rf "$INSTALL_DIR/cast_helper"
  cp -a "$HELPER_SRC/cast_helper" "$INSTALL_DIR/cast_helper"
  find "$INSTALL_DIR/cast_helper" -name __pycache__ -type d -prune -exec rm -rf {} + 2>/dev/null || true
  cp -f "$HELPER_SRC/requirements.txt" "$INSTALL_DIR/requirements.txt"

  if [[ ! -d "$INSTALL_DIR/venv" ]]; then
    python3 -m venv --system-site-packages "$INSTALL_DIR/venv"
  fi
  # shellcheck disable=SC1091
  source "$INSTALL_DIR/venv/bin/activate"
  pip install -q --upgrade pip
  pip install -q -r "$INSTALL_DIR/requirements.txt"
  deactivate

  PYTHON="$INSTALL_DIR/venv/bin/python"
  sed -e "s|@PYTHON@|$PYTHON|g" -e "s|@INSTALL_DIR@|$INSTALL_DIR|g" \
    "$HELPER_SRC/cast-helper.service" > "$UNIT_DIR/cast-helper.service"

  cat > "$DBUS_DIR/org.cast.tools.Cast1.service" <<EOF
[D-BUS Service]
Name=org.cast.tools.Cast1
Exec=/bin/false
SystemdService=cast-helper.service
EOF

  systemctl --user daemon-reload
  systemctl --user enable --now cast-helper.service
  echo "    Helper active: $(systemctl --user is-active cast-helper.service)"
}

install_extension() {
  echo "==> Installing GNOME Shell extension → $EXT_DIR"
  if [[ "${XDG_SESSION_TYPE:-}" != "wayland" && "${XDG_SESSION_TYPE:-}" != "x11" ]]; then
    echo "WARNING: could not detect session type; GNOME on Wayland is recommended."
  fi

  if command -v gnome-shell >/dev/null 2>&1; then
    ver="$(gnome-shell --version 2>/dev/null | grep -oE '[0-9]+' | head -1 || true)"
    if [[ -n "$ver" && "$ver" -lt 45 ]]; then
      echo "ERROR: GNOME Shell 45+ required (found $ver)." >&2
      exit 1
    fi
  fi

  glib-compile-schemas "$ROOT/schemas/"
  mkdir -p "$(dirname "$EXT_DIR")"
  # Prefer symlink so repo edits apply after Shell restart
  ln -sfn "$ROOT" "$EXT_DIR"
  gnome-extensions enable "$UUID" 2>/dev/null || true
  echo "    Enabled $UUID (symlink → $ROOT)"
}

if [[ "$UNINSTALL" -eq 1 ]]; then
  uninstall_all
  exit 0
fi

echo "Cast Display installer"
echo "======================"
install_helper
if [[ "$HELPER_ONLY" -eq 0 ]]; then
  install_extension
fi

offer_firewall_rule

echo
echo "Install complete."
if [[ "${XDG_SESSION_TYPE:-}" == "wayland" ]]; then
  echo "  On Wayland the Shell cannot reload itself, so log out and back in"
  echo "  for the tile to appear. The helper is already running; no reboot."
else
  echo "  On X11 press Alt+F2, type r and press Enter to reload the Shell."
fi
echo "  Then open Quick Settings → Cast Display → Connect."
echo "  Helper logs: journalctl --user -u cast-helper.service -f"
echo "  List devices: gdbus call --session -d org.cast.tools.Cast1 \\"
echo "    -o /org/cast/tools/Cast1 \\"
echo "    -m org.freedesktop.DBus.Properties.Get org.cast.tools.Cast1 Devices"
echo
echo "==> Diagnostics"
(cd "$INSTALL_DIR" && PYTHONPATH="$INSTALL_DIR" \
  "$INSTALL_DIR/venv/bin/python" -m cast_helper --doctor --no-discovery 2>&1 | tail -n 3) || true
