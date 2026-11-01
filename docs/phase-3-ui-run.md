# Phase 3 — recorded UI run

The brief asks for a screencast or written log of the extension driven end to
end. This is the written log, and it is reproducible:

```bash
cd helpers/cast-helper
./dev/run_nested_shell.sh              # headless, scripted
./dev/run_nested_shell.sh --devkit     # a window you can click in
```

The harness starts a private session bus, the dev helper (`videotestsrc` plus
two ffprobe receivers), and a real GNOME Shell with **only** this extension
enabled, installed into a throwaway `XDG_DATA_HOME`. It then drives a full
cast lifecycle over D-Bus and greps the Shell's log.

## Run of 2026-10-31, GNOME Shell 50.1, headless

```text
--- extension info ---
display-and-cast@cast.tools
  Name: Cast Display
  Enabled: Yes
  State: ACTIVE

--- scripted lifecycle ---
StartCast -> fake:8f0763da-2477-5106-85b8-cded62a78966
  stream=61960b9b0a6686b2
  State: (<'streaming'>,)
AddDevices -> fake:b1cfc71f-bd43-531a-ab8e-43f1402acb2f
  Sessions: 'state': <'playing'> 'state': <'playing'>
RemoveDevice -> fake:b1cfc71f-bd43-531a-ab8e-43f1402acb2f
Simulating a screen lock (extension disable/enable)
  State after relock: (<'streaming'>,)      <-- gap G4: the cast survived
StopAll
  State: (<'idle'>,)
```

Checks against the exit criteria:

| Criterion | Result |
| --- | --- |
| Extension loads and reaches ACTIVE | yes |
| Devices appear without flicker | rows are kept in a `Map` and updated in place; `destroy_all_children` is gone from the codebase |
| Connect → states progress to Playing | both sessions reached `playing` |
| Add a device mid-stream | `AddDevices` succeeded with no new pipeline, portal or port |
| Disconnect one | `RemoveDevice` succeeded, the other kept playing |
| Lock and unlock | `disable()`/`enable()` left `State=streaming` |
| Turn off | `StopAll` returned `State=idle` |
| No Shell warnings from the extension | see below |
| ESLint clean | 8 files, 0 errors, 0 warnings |

## The only remaining log line, and why it is there

```text
[display-and-cast] Keeping the screen awake is unavailable;
presentation mode will only hide notifications:
GDBus.Error:org.freedesktop.DBus.Error.ServiceUnknown:
The name org.gnome.SessionManager was not provided by any .service files
```

A nested session has no `org.gnome.SessionManager`, so the idle inhibitor
cannot be taken. It is logged **once per extension enable** (twice in the run
above, because the test disables and re-enables the extension to simulate a
lock), and presentation mode continues in its degraded form, hiding banners.
On a real desktop the session manager exists and this line does not appear.

Everything else in the Shell log is environmental: mutter's experimental
feature warnings, the nested Wayland lockfile, a missing geolocation portal
entry, an NM typelib mismatch, and criticals from GNOME's own
`dateMenu.js:512` during shutdown. Raw log:
[`phase-3-nested-shell-run.log`](phase-3-nested-shell-run.log).

## Bugs this run found that nothing else would have

1. **`gettext` at module scope.** `const SESSION_LABELS = {a: _('…')}` threw
   `Error: gettext can only be called from extensions` at import time on
   GNOME 45+, so the menu module failed to load at all. Neither ESLint nor
   `node --check` can see this; only a real Shell can. Labels are now built
   on demand.

2. **Syncing into disposed actors.** Clutter disposes actors from C during
   Shell shutdown, before any JS `destroy()` runs. A D-Bus property change
   arriving in that window drove `_sync()` into dead `St.Label`s and produced
   a page of "already disposed" criticals. The guard now hangs off each
   actor's own `destroy` signal, not just the `destroy()` method.

3. **A log-spamming retry loop.** Presentation mode treated "hide banners"
   and "inhibit idle" as one unit, so a failure left `_enabled` false and the
   whole thing was retried, and logged, on every state sync — eight times in
   a 40 second run. The two concerns are now independent, the failure is
   recorded once, and concurrent `enable()` calls share one in-flight attempt
   instead of racing.

4. **The harness was testing the wrong code.** The first version reused the
   real `~/.local/share/gnome-shell/extensions` directory, whose symlink for
   this UUID points at a *second, stale checkout* of this repo
   (`/home/emm/projects/tools/cast`, sitting at the pre-Phase-0 baseline).
   Several runs silently exercised September's code. The harness now installs
   into a private `XDG_DATA_HOME`, and enables only this extension so another
   installed extension's warnings cannot be misread as ours.

## Note for whoever runs this on the reference machine

The VS Code **snap** terminal leaks its own library paths into child
processes, which makes `xdg-desktop-portal` die with a `libpthread` symbol
error and takes GNOME's own Extensions D-Bus service down with it. The
harness detects `$SNAP` and re-runs itself under `systemd-run --user` to get
a clean environment. The installed systemd unit is unaffected, because it
already runs in the user session's environment.
