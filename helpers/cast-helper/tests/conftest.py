import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

# Variables that change what the helper does. A developer with the dev
# harness exported, or a CI job that sets them for the integration tests,
# would otherwise silently alter unit-test behaviour: fake devices appear in
# discovery results, and the stream server grants loopback. Four tests failed
# that way before this existed.
HARNESS_VARS = (
    "CAST_HELPER_TEST_SOURCE",
    "CAST_HELPER_FAKE_DEVICES",
    "CAST_HELPER_TEST_SIZE",
)


@pytest.fixture(autouse=True)
def _hermetic_environment(monkeypatch):
    """Run every test as if the dev harness were switched off.

    Tests that want the harness opt in explicitly with monkeypatch.setenv,
    and the service integration tests pass their own env to the subprocess
    they start, so neither is affected.
    """
    for name in HARNESS_VARS:
        monkeypatch.delenv(name, raising=False)
