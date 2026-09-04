#!/usr/bin/env bash
# Cast Display — one-command install (extension + cast helper).
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

uninstall_all() {
  echo "==> Uninstalling Cast Display"
  gnome-extensions disable "$UUID" 2>/dev/null || true
  systemctl --user disable --now cast-helper.service 2>/dev/null || true
  rm -f "$UNIT_DIR/cast-helper.service"
  rm -f "$DBUS_DIR/org.cast.tools.Cast1.service"
  rm -rf "${XDG_DATA_HOME:-$HOME/.local/share}/cast-display"
  if [[ -L "$EXT_DIR" || -d "$EXT_DIR" ]]; then
    rm -rf "$EXT_DIR"
  fi
  systemctl --user daemon-reload 2>/dev/null || true
  echo "Done. Log out and back in on Wayland to finish unloading the extension."
}

install_helper() {
  echo "==> Installing cast helper → $INSTALL_DIR"
  mkdir -p "$INSTALL_DIR" "$UNIT_DIR" "$DBUS_DIR"

  need_pkgs=()
  for pkg in python3-venv python3-gi python3-dbus ffmpeg \
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

  cp -f "$HELPER_SRC/cast_helper.py" "$INSTALL_DIR/cast_helper.py"
  cp -f "$HELPER_SRC/requirements.txt" "$INSTALL_DIR/requirements.txt"
  chmod +x "$INSTALL_DIR/cast_helper.py"

  if [[ ! -d "$INSTALL_DIR/venv" ]]; then
    python3 -m venv --system-site-packages "$INSTALL_DIR/venv"
  fi
  # shellcheck disable=SC1091
  source "$INSTALL_DIR/venv/bin/activate"
  pip install -q --upgrade pip
  pip install -q -r "$INSTALL_DIR/requirements.txt"
  deactivate

  PYTHON="$INSTALL_DIR/venv/bin/python"
  SCRIPT="$INSTALL_DIR/cast_helper.py"
  sed -e "s|@PYTHON@|$PYTHON|g" -e "s|@SCRIPT@|$SCRIPT|g" \
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

echo
echo "Install complete."
echo "  On Wayland: log out and log back in so Quick Settings reloads."
echo "  Then open Quick Settings → Cast Display → Connect."
echo "  Helper logs: journalctl --user -u cast-helper.service -f"
echo "  Test devices: gdbus call --session -d org.cast.tools.Cast1 \\"
echo "    -o /org/cast/tools/Cast1 -m org.cast.tools.Cast1.ListDevices"
