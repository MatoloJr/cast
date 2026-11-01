# Phase 4 — real display modes

How Mirror, Extend and "turn off this computer's screens" were made to mean
something for the receiver, and what was measured along the way.

## The bug underneath gap G1

`lib/displayConfig.js` built its proxy like this:

```js
this._proxy = new DisplayConfigProxy(Gio.BusType.SESSION, BUS_NAME, …);
```

`Gio.DBusProxy` wants a `Gio.DBusConnection`; `Gio.BusType.SESSION` is a
plain number. Construction therefore threw

```text
[display-and-cast] Failed to create DisplayConfig proxy:
Error: Wrong type number; object GDBusConnection expected
[display-and-cast] getCurrentState in refresh failed:
Error: DisplayConfig proxy unavailable
```

on every single enable, visible in the nested-shell log. So **no layout
action had ever reached Mutter**. The audit put G1 down to "a Chromecast
isn't a Mutter monitor", which is true and is the deeper problem, but the
proximate cause was that the display code did not run at all.

## Extend: the portal really does create a monitor

Asking `SelectSources` for `types=VIRTUAL` (bit 4) on
xdg-desktop-portal-gnome 50 makes Mutter create a monitor, and it shows up
in `GetCurrentState` as a normal one:

```text
('Meta-0', 'MetaVendor', 'Virtual remote monitor', '0x000005'),
  [('1920x1080@60.000', 1920, 1080, 60.0, 1.0,
    [1.0, 1.25, 1.3333, 1.5, 1.6667, 2.0], {'is-current': true, …})]
```

and in the logical layout beside the built-in panel:

```text
eDP-1:  x=0    y=0 scale=1.0 primary=true
Meta-0: x=1366 y=0 scale=1.0 primary=false
```

With the stream running, the fake receiver reported `playing`, i.e. the
virtual monitor's contents encoded and decoded correctly. On `StopAll` the
monitor disappears and the previous layout returns.

So Extend is genuine here: windows can be dragged onto a real second
screen, and it is a real Mutter monitor rather than a picture of one.

### The 2×2 trap, and the exact caps that avoid it

**A virtual monitor has no inherent size.** Mutter sizes it from whatever
the consumer negotiates over PipeWire. The node advertises an enormous
range:

```text
EnumFormat size: {default: 1280x720, min: 1x1, max: 16384x16386}
```

Measured, with the caps filter placed immediately after `pipewiresrc`:

| Caps after `pipewiresrc` | Negotiated | Monitor Mutter creates |
|---|---|---|
| *(none)* | — | `set_state` **FAILURE** |
| `width=[2,1920],height=[2,1080]` | 2×2 | **`2x2@60`** — useless |
| `width=1920,height=1080` | 1920×1080 | **`1920x1080@60`** ✓ |
| `width=1280,height=720` | 1280×720 | `1280x720@60` ✓ |
| `width=1920,height=1080,framerate=30/1` | — | `set_state` **FAILURE** |
| `width=1920,height=1080,framerate=[1/1,60/1]` | — | `set_state` **FAILURE** |

Two findings that are easy to get wrong and produce a feature that looks
implemented and isn't:

1. **A range yields a 2×2 monitor.** Negotiation takes the minimum. The
   first version of this pipeline used the same capped range as Mirror and
   produced exactly that: a "working" Extend with a two-pixel desktop.
2. **Any framerate constraint stops the pipeline from starting at all.**
   Width and height only; `videorate` and the caps further downstream set
   the rate.

So in extend mode the pipeline inserts `! video/x-raw,width=W,height=H`
directly after `pipewiresrc`, and nothing else. Mirror keeps the capped
range, which is what lets a smaller screen pass through unscaled.

Because that number *is* the size of the desktop the user gets, extend
defaults to 1080p even on a software encoder, where mirror drops to 720p.
Preferences can override it.

## Mirror: a common mode, not each monitor's own (gap G2)

Mutter rejects a logical monitor whose members do not share a mode, which is
why the old builder — using each monitor's current mode — failed with
"Layout could not be applied" on any mixed-resolution pair.
`findCommonMode` intersects the modes, largest area first, then picks the
highest refresh rate available at that resolution on every monitor, and
intersects the *supported scales* too, since Mutter also rejects a scale a
member's mode does not advertise.

Worked example from the fixtures: a 1366×768 laptop panel plus a 1920×1080
external share neither native mode, but both offer 1280×720 and 1024×768, so
mirroring settles on **1280×720**. When nothing is shared the UI is told
why, naming both resolutions, instead of a generic failure.

## Safety: the revert timer (gap G3)

`disablesAnActiveMonitor` compares the layout about to be applied against
the monitors currently lit. Anything that would switch one off goes through
`LayoutGuard`, which applies with `ApplyMethod.TEMPORARY`, shows a
"Keep these display settings?" dialog counting down from **15 s**, and
reverts on timeout, on Escape, or if the stream dies underneath it. Only an
explicit "Keep changes" writes the layout with `ApplyMethod.PERSISTENT`.
The pre-cast layout is captured before anything is applied and restored when
the stream stops, then compared with `sameLayout` to confirm it really came
back.

## Groups: deliberately not implemented

The brief makes this optional and says to skip it if the Phase 2 CPU numbers
do not support it, and to say why. They do not.

Reference machine: **Intel i5-4300U, 4 threads, no working VA-API encoder.**
Measured in Phase 2:

- 720p30 x264: **61%** of one core
- 1080p30 x264: **114–132%** of one core

Two concurrent streams at 1080p would want ~2.5 of 4 threads for encoding
alone, before capture, muxing and the rest of the desktop. One encode fanned
out to many receivers — which already works, and is the feature that
actually matters — costs one encoder regardless of how many televisions are
attached. A second *stream* only buys the ability to send different content
to different groups, which is a niche want at double the cost on hardware
that cannot afford the first one.

`Streams` is therefore an array in the D-Bus API and the helper is written
so a second stream is not structurally excluded, but nothing creates one and
no UI offers it. Revisit on a machine with a hardware encoder, where the
marginal cost is a second VA-API session rather than 1.3 CPU cores — and
note that some VA drivers cap concurrent encode sessions, which would need
checking first.

## What still needs hardware

- **A second physical monitor.** Common-mode mirroring and "use only this
  screen" are unit-tested against recorded fixtures (1, 2 and 3 monitors,
  mixed scales), but this machine has one panel, so the apply path for
  local layouts is unverified.
- **The revert dialog.** `LayoutGuard`'s decision logic is unit-tested;
  the dialog itself needs a live session to appear in. Checklist item 9 in
  [manual-tests.md](manual-tests.md).
- **Dragging a window onto the extended screen**, and whether the receiver
  shows it at a sensible scale.

## Reproducing the measurements

```bash
cd helpers/cast-helper
systemctl --user stop cast-helper.service
CAST_HELPER_FAKE_DEVICES=1 PYTHONPATH=. \
  ~/.local/share/cast-display/cast-helper/venv/bin/python -m cast_helper &
gdbus call --session -d org.cast.tools.Cast1 -o /org/cast/tools/Cast1 \
  -m org.cast.tools.Cast1.StartCast "['<fake id>']" "{'mode': <'extend'>}"
gdbus call --session -d org.gnome.Mutter.DisplayConfig \
  -o /org/gnome/Mutter/DisplayConfig \
  -m org.gnome.Mutter.DisplayConfig.GetCurrentState | grep -o "Meta-0.\{0,160\}"
```

Note: calling the bus name **D-Bus-activates the installed systemd unit**,
which then competes with a dev helper for the name and makes the dev one log
"lost the bus name". Stop the unit first, and check the name's owner is the
process you think it is.
