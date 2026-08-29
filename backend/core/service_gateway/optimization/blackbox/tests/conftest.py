"""Fixtures shared by the black-box tests."""

from __future__ import annotations

import pytest

from core.config import settings


@pytest.fixture(autouse=True)
def local_scorer_runtime(monkeypatch: pytest.MonkeyPatch) -> None:
    """Keep python scorers on the host: a developer's ``VERCEL_*`` settings must never open real boxes from the suite.

    Args:
        monkeypatch: Pytest fixture.
    """
    monkeypatch.setattr(settings, "blackbox_scorer_runtime", "local")
