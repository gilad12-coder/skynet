"""Shared fixtures for every unit test under ``core/``."""

from __future__ import annotations

import os
import zlib

import pytest

from core.api import interview_model
from core.billing import openrouter_prices


@pytest.fixture(autouse=True)
def _offline_openrouter_prices(monkeypatch: pytest.MonkeyPatch) -> None:
    """Keep pricing off the network so charges come from the static table or fallback.

    Args:
        monkeypatch: Pytest's patch fixture, which restores the flag afterwards.
    """
    openrouter_prices.reset()
    monkeypatch.setattr(openrouter_prices, "fetch_enabled", False)


@pytest.fixture(autouse=True)
def _offline_interview_model(monkeypatch: pytest.MonkeyPatch) -> None:
    """Keep the interview-model pick from fetching OpenRouter stats in a background thread.

    Args:
        monkeypatch: Pytest's patch fixture.
    """
    monkeypatch.setattr(interview_model, "_kick_refresh", lambda: None)


def pytest_collection_modifyitems(config: pytest.Config, items: list[pytest.Item]) -> None:
    """Keep only this CI shard's test files when ``SKYNET_TEST_SHARD`` is set.

    CI splits ``core/`` across parallel jobs with ``SKYNET_TEST_SHARD=i/n``.
    Whole files land on one shard, by a stable hash of their path, so module
    fixtures still run once per file.

    Args:
        config: The pytest config, used to report deselected tests.
        items: The collected tests, filtered in place.
    """
    spec = os.environ.get("SKYNET_TEST_SHARD")
    if not spec:
        return
    index, total = (int(part) for part in spec.split("/"))
    keep, drop = [], []
    for item in items:
        bucket = zlib.crc32(item.nodeid.split("::")[0].encode()) % total
        (keep if bucket == index else drop).append(item)
    items[:] = keep
    config.hook.pytest_deselected(items=drop)
