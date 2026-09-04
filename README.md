# Display & Cast (Phase 1)

GNOME Shell Quick Settings extension for multi-monitor layouts and presentation mode on Ubuntu / GNOME 45+ (Wayland). Casting is planned for later phases.

## Features

- **Displays** menu in Quick Settings with quick layouts: Extend, Mirror all, Main only, Secondary only
- **Custom grouping** when 3+ monitors are connected (mirror within a group, extend across groups)
- **Presentation mode** toggle: inhibits idle/suspend and enables Do Not Disturb

Display changes go through Mutter’s `org.gnome.Mutter.DisplayConfig` D-Bus API — no `xrandr`.

## Requirements

- GNOME Shell 45–50 (tested on GNOME Shell 50 / Ubuntu 26.04)
- Wayland session

## Install (development symlink)

Prefer a symlink so edits in this repo load after a Shell restart. Do **not** run `gnome-extensions install` over a symlink — that can wipe the linked directory.

```bash
# Compile the GSettings schema
glib-compile-schemas schemas/

# Symlink into the user extensions directory
mkdir -p ~/.local/share/gnome-shell/extensions
ln -sfn "$(pwd)" ~/.local/share/gnome-shell/extensions/display-and-cast@cast.tools

# Enable (after the Shell has scanned the new extension — usually after logout/login)
gnome-extensions enable display-and-cast@cast.tools
```

## Install (packaged zip)

```bash
gnome-extensions pack . --force \
  --extra-source=lib \
  --extra-source=ui \
  --extra-source=README.md

# Install into ~/.local/share/... (copies files; remove any symlink first)
rm -f ~/.local/share/gnome-shell/extensions/display-and-cast@cast.tools
gnome-extensions install --force display-and-cast@cast.tools.shell-extension.zip
gnome-extensions enable display-and-cast@cast.tools
```

## Reload the shell

- **Wayland** (Ubuntu default): log out and log back in, or reboot. `Alt+F2` → `r` does **not** reload the shell on Wayland.
- **X11**: `Alt+F2`, type `r`, Enter.

After enabling for the first time on Wayland, a new login is required before the extension loads.

## Logs

```bash
journalctl -f -o cat /usr/bin/gnome-shell
```

Filter for this extension:

```bash
journalctl -f -o cat /usr/bin/gnome-shell | grep -i display-and-cast
```

## Disable / uninstall

```bash
gnome-extensions disable display-and-cast@cast.tools
# Symlink install:
rm ~/.local/share/gnome-shell/extensions/display-and-cast@cast.tools
# Zip install:
rm -rf ~/.local/share/gnome-shell/extensions/display-and-cast@cast.tools
```

## Layout notes

| Action | Behavior |
|--------|----------|
| Extend | One logical monitor per display, side by side |
| Mirror all | All displays share one logical monitor |
| Main only | Builtin (or primary) display only; others disabled |
| Secondary only | First non-main display only; others disabled |
| Custom groups | Same letter = mirrored; different letters = extended |

Group assignments are stored by connector name in extension settings and restored when that connector reappears.
