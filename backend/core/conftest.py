"""Shared fixtures for every unit test under ``core/``."""

from __future__ import annotations

import pytest

from core.billing import openrouter_prices


@pytest.fixture(autouse=True)
def _offline_openrouter_prices(monkeypatch: pytest.MonkeyPatch) -> None:
    """Keep pricing off the network so charges come from the static table or fallback.

    Args:
        monkeypatch: Pytest's patch fixture, which restores the flag afterwards.
    """
    openrouter_prices.reset()
    monkeypatch.setattr(openrouter_prices, "fetch_enabled", False)
