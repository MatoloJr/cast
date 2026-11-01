"""The helper's state machine.

One place decides what state the helper is in and every transition is
declared. Nothing else is allowed to assign to the state, which is what keeps
the D-Bus `State` property honest: it cannot say "streaming" unless a
`PIPELINE_READY` event actually arrived.

Transitions, as the brief specifies them:

    idle → starting(portal) → starting(pipeline) → streaming
    streaming ⇄ receivers come and go
    any → stopping → idle
    any → error → idle

`STOP` is accepted in **every** state, including midway through an async
starting step. That is the whole point: defect S1 was a Stop that could
deadlock while the portal dialog was open.
"""

from __future__ import annotations

import logging
from collections.abc import Callable
from enum import Enum

LOG = logging.getLogger("cast-helper.state")


class State(str, Enum):
    IDLE = "idle"
    STARTING = "starting"
    STREAMING = "streaming"
    STOPPING = "stopping"
    ERROR = "error"

    def __str__(self) -> str:
        return self.value


class Step(str, Enum):
    """Sub-step of STARTING, for the UI's benefit. Not a state."""

    NONE = ""
    PORTAL = "portal"
    PIPELINE = "pipeline"
    RECEIVERS = "receivers"

    def __str__(self) -> str:
        return self.value


class Event(str, Enum):
    START = "start"                      # StartCast accepted
    PORTAL_READY = "portal_ready"        # got the PipeWire fd + node
    PIPELINE_READY = "pipeline_ready"    # encoder running, bytes flowing
    STOP = "stop"                        # StopStream / StopAll / tile off
    STOPPED = "stopped"                  # teardown finished
    FAIL = "fail"                        # unrecoverable problem
    RESET = "reset"                      # leave error, back to idle

    def __str__(self) -> str:
        return self.value


class InvalidTransition(Exception):
    def __init__(self, state: State, event: Event):
        super().__init__(f"cannot {event} while {state}")
        self.state = state
        self.event = event


# (from state, event) -> (to state, to step)
_TABLE: dict[tuple[State, Event], tuple[State, Step]] = {
    (State.IDLE, Event.START): (State.STARTING, Step.PORTAL),
    (State.IDLE, Event.STOP): (State.IDLE, Step.NONE),          # no-op, benign
    (State.IDLE, Event.FAIL): (State.ERROR, Step.NONE),

    (State.STARTING, Event.PORTAL_READY): (State.STARTING, Step.PIPELINE),
    (State.STARTING, Event.PIPELINE_READY): (State.STREAMING, Step.NONE),
    (State.STARTING, Event.STOP): (State.STOPPING, Step.NONE),
    (State.STARTING, Event.FAIL): (State.ERROR, Step.NONE),

    (State.STREAMING, Event.STOP): (State.STOPPING, Step.NONE),
    (State.STREAMING, Event.FAIL): (State.ERROR, Step.NONE),
    # Receivers joining and leaving do not change the state at all; the
    # Sessions property carries that. Re-asserting STREAMING is a no-op so
    # callers do not have to special-case it.
    (State.STREAMING, Event.PIPELINE_READY): (State.STREAMING, Step.NONE),

    (State.STOPPING, Event.STOPPED): (State.IDLE, Step.NONE),
    (State.STOPPING, Event.STOP): (State.STOPPING, Step.NONE),   # idempotent
    (State.STOPPING, Event.FAIL): (State.ERROR, Step.NONE),

    (State.ERROR, Event.RESET): (State.IDLE, Step.NONE),
    (State.ERROR, Event.STOP): (State.IDLE, Step.NONE),
    (State.ERROR, Event.START): (State.STARTING, Step.PORTAL),
}


class StateMachine:
    """Holds the current state and notifies on change.

    `on_change(state, step, error)` runs on whatever thread fired the event.
    The service only ever fires events from the GLib main thread, so the
    callback is main-thread too.
    """

    def __init__(self, on_change: Callable[[State, Step, str], None] | None = None):
        self._state = State.IDLE
        self._step = Step.NONE
        self._error = ""
        self._on_change = on_change
        # Bumped on every STOP so in-flight async work can tell that the
        # operation it belongs to has been abandoned.
        self._generation = 0

    @property
    def state(self) -> State:
        return self._state

    @property
    def step(self) -> Step:
        return self._step

    @property
    def error(self) -> str:
        return self._error

    @property
    def generation(self) -> int:
        return self._generation

    def is_busy(self) -> bool:
        return self._state in (State.STARTING, State.STREAMING, State.STOPPING)

    def can(self, event: Event) -> bool:
        return (self._state, event) in _TABLE

    def fire(self, event: Event, error: str = "") -> bool:
        """Apply `event`. Returns True if the state or step changed.

        Raises InvalidTransition for an event the current state does not
        accept, so a logic error is loud rather than silently ignored.
        """
        key = (self._state, event)
        if key not in _TABLE:
            raise InvalidTransition(self._state, event)
        to_state, to_step = _TABLE[key]

        if event in (Event.STOP, Event.FAIL):
            # Abandon anything still in flight for the previous generation.
            self._generation += 1

        if event == Event.FAIL:
            self._error = error or "unknown error"
        elif event in (Event.START, Event.RESET, Event.STOPPED):
            self._error = ""

        changed = (to_state, to_step) != (self._state, self._step)
        previous = (self._state, self._step)
        self._state, self._step = to_state, to_step

        if changed:
            LOG.info(
                "state: %s(%s) --%s--> %s(%s)%s",
                previous[0], previous[1] or "-", event,
                to_state, to_step or "-",
                f" error={self._error!r}" if self._error else "",
            )
            if self._on_change:
                self._on_change(to_state, to_step, self._error)
        return changed

    def fire_if_possible(self, event: Event, error: str = "") -> bool:
        """Like `fire`, but a disallowed event is ignored rather than raised.

        Used by late async callbacks, which can legitimately arrive after the
        operation they belong to was stopped.
        """
        if not self.can(event):
            LOG.debug("ignoring %s while %s", event, self._state)
            return False
        return self.fire(event, error)
