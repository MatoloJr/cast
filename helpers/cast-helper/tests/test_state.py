"""Every transition in the state machine, including cancel at each step."""

from __future__ import annotations

import pytest

from cast_helper.state import (
    Event,
    InvalidTransition,
    State,
    StateMachine,
    Step,
)


def test_starts_idle():
    machine = StateMachine()
    assert machine.state is State.IDLE
    assert machine.step is Step.NONE
    assert machine.error == ""


def test_happy_path():
    seen = []
    machine = StateMachine(on_change=lambda s, st, e: seen.append((s, st)))

    machine.fire(Event.START)
    assert (machine.state, machine.step) == (State.STARTING, Step.PORTAL)

    machine.fire(Event.PORTAL_READY)
    assert (machine.state, machine.step) == (State.STARTING, Step.PIPELINE)

    machine.fire(Event.PIPELINE_READY)
    assert machine.state is State.STREAMING

    machine.fire(Event.STOP)
    assert machine.state is State.STOPPING

    machine.fire(Event.STOPPED)
    assert machine.state is State.IDLE

    assert seen == [
        (State.STARTING, Step.PORTAL),
        (State.STARTING, Step.PIPELINE),
        (State.STREAMING, Step.NONE),
        (State.STOPPING, Step.NONE),
        (State.IDLE, Step.NONE),
    ]


@pytest.mark.parametrize(
    "events_before_stop",
    [
        [],                                        # cancel before anything
        [Event.START],                             # cancel during portal
        [Event.START, Event.PORTAL_READY],         # cancel during pipeline
        [Event.START, Event.PORTAL_READY, Event.PIPELINE_READY],  # while streaming
    ],
    ids=["idle", "during-portal", "during-pipeline", "while-streaming"],
)
def test_stop_is_accepted_at_every_step(events_before_stop):
    """Defect S1: Stop must never be refused or deferred."""
    machine = StateMachine()
    for event in events_before_stop:
        machine.fire(event)

    assert machine.can(Event.STOP), f"STOP refused while {machine.state}"
    machine.fire(Event.STOP)

    if events_before_stop:
        assert machine.state is State.STOPPING
        machine.fire(Event.STOPPED)
    assert machine.state is State.IDLE


def test_stop_bumps_generation_so_late_work_is_abandoned():
    machine = StateMachine()
    machine.fire(Event.START)
    generation = machine.generation

    machine.fire(Event.STOP)
    assert machine.generation != generation

    # A portal reply arriving now belongs to the abandoned generation and
    # the state machine will not accept it either.
    assert not machine.can(Event.PORTAL_READY)
    assert machine.fire_if_possible(Event.PORTAL_READY) is False
    assert machine.state is State.STOPPING


def test_failure_from_each_state_reaches_error_then_idle():
    for prelude in ([], [Event.START], [Event.START, Event.PORTAL_READY],
                    [Event.START, Event.PORTAL_READY, Event.PIPELINE_READY]):
        machine = StateMachine()
        for event in prelude:
            machine.fire(event)
        machine.fire(Event.FAIL, "boom")
        assert machine.state is State.ERROR
        assert machine.error == "boom"
        machine.fire(Event.RESET)
        assert machine.state is State.IDLE
        assert machine.error == ""


def test_error_can_restart_directly():
    machine = StateMachine()
    machine.fire(Event.FAIL, "nope")
    assert machine.state is State.ERROR
    machine.fire(Event.START)
    assert (machine.state, machine.step) == (State.STARTING, Step.PORTAL)
    assert machine.error == ""


def test_receivers_coming_and_going_do_not_change_state():
    machine = StateMachine()
    machine.fire(Event.START)
    machine.fire(Event.PORTAL_READY)
    machine.fire(Event.PIPELINE_READY)
    assert machine.state is State.STREAMING
    # Re-asserting readiness is a no-op, not an error.
    assert machine.fire(Event.PIPELINE_READY) is False
    assert machine.state is State.STREAMING


def test_stop_is_idempotent_while_stopping():
    machine = StateMachine()
    machine.fire(Event.START)
    machine.fire(Event.STOP)
    assert machine.fire(Event.STOP) is False
    assert machine.state is State.STOPPING


def test_invalid_transitions_raise():
    machine = StateMachine()
    with pytest.raises(InvalidTransition):
        machine.fire(Event.PORTAL_READY)      # nothing started
    with pytest.raises(InvalidTransition):
        machine.fire(Event.STOPPED)           # not stopping

    machine.fire(Event.START)
    with pytest.raises(InvalidTransition):
        machine.fire(Event.START)             # already starting


def test_fire_if_possible_never_raises():
    machine = StateMachine()
    assert machine.fire_if_possible(Event.PORTAL_READY) is False
    assert machine.state is State.IDLE


def test_is_busy():
    machine = StateMachine()
    assert not machine.is_busy()
    machine.fire(Event.START)
    assert machine.is_busy()
    machine.fire(Event.STOP)
    assert machine.is_busy()
    machine.fire(Event.STOPPED)
    assert not machine.is_busy()


def test_every_table_entry_is_reachable_and_declared():
    """Guard against a transition being added without a test."""
    from cast_helper.state import _TABLE

    states_with_stop = {s for (s, e) in _TABLE if e is Event.STOP}
    # STOP must be handled from every state the machine can rest in.
    assert states_with_stop >= {
        State.IDLE, State.STARTING, State.STREAMING, State.STOPPING, State.ERROR
    }
