"""Tests for the long-step heartbeat."""

from __future__ import annotations

import logging
import threading
import time

import pytest

from .. import heartbeat as heartbeat_mod
from ..heartbeat import duration, heartbeat

_LOG = logging.getLogger("core.service_gateway.optimization.blackbox.tests.heartbeat")


def test_duration_reads_like_a_person_would() -> None:
    """Seconds under a minute, minutes with one decimal above it."""
    assert [duration(s) for s in (0.4, 45, 60, 90, 600)] == ["0s", "45s", "1.0m", "1.5m", "10.0m"]


def test_heartbeat_logs_while_the_block_runs_and_stops_after(
    monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    """The line repeats every interval until the block ends, then never again."""
    monkeypatch.setattr(heartbeat_mod, "HEARTBEAT_SECONDS", 0.02)
    with caplog.at_level(logging.INFO, logger=_LOG.name):
        with heartbeat(_LOG, "agent run 1", "install", 600):
            time.sleep(0.1)
        beats = len(caplog.records)
        time.sleep(0.05)

    assert beats >= 2
    assert len(caplog.records) == beats
    assert caplog.records[0].getMessage().startswith("agent run 1: install still running after ")
    assert caplog.records[0].getMessage().endswith("(allowance 10.0m)")
    assert not any(thread.name.startswith("heartbeat-") for thread in threading.enumerate())


def test_heartbeat_stays_silent_for_a_quick_step(
    monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    """A step that ends before the first interval logs nothing."""
    monkeypatch.setattr(heartbeat_mod, "HEARTBEAT_SECONDS", 5.0)
    with caplog.at_level(logging.INFO, logger=_LOG.name), heartbeat(_LOG, "agent run 1", "install", 600):
        pass

    assert caplog.records == []
