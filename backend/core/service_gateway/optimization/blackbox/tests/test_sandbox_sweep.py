"""Tests for the tag-based sweep that stops the boxes a killed job left running."""

from __future__ import annotations

import contextlib
from collections.abc import Iterator
from typing import Any

import pytest

from .. import sandbox as sandbox_mod
from ..sandbox import JOB_TAG, VercelCredentials, VercelSandboxRuntime


class _ListedBox:
    """A sandbox as the SDK lists it: a name, a status and ``stop``."""

    def __init__(self, name: str, status: str, *, fail: bool = False) -> None:
        """Remember the box's listing and whether ``stop`` refuses."""
        self.name = name
        self.status = status
        self.stopped = False
        self._fail = fail

    def stop(self) -> None:
        """Stop the box, or refuse."""
        if self._fail:
            raise RuntimeError("stop refused")
        self.stopped = True


class _QuerySync:
    """Fake ``vercel.sandbox.sync`` exposing only the listing surface."""

    def __init__(self, boxes: list[_ListedBox]) -> None:
        """Hold the boxes every query lists."""
        self.boxes = boxes
        self.filters: list[tuple[str, str]] = []
        self.credentials: dict[str, str] = {}

    def SandboxServiceOptions(self, credentials_factory: Any) -> str:  # noqa: N802 - SDK name
        """Capture the credentials factory and invoke it once."""
        self.credentials = credentials_factory()
        return "options"

    def SandboxCredentials(self, token: str, team_id: str, project_id: str) -> dict[str, str]:  # noqa: N802
        """Return the credentials as a dict."""
        return {"token": token, "team_id": team_id, "project_id": project_id}

    def TagFilter(self, key: str, value: str) -> tuple[str, str]:  # noqa: N802
        """Return the filter as a pair."""
        return (key, value)

    def SandboxQueryByCreatedAt(self, tag: tuple[str, str]) -> tuple[str, str]:  # noqa: N802
        """Record the tag filter and return it as the query."""
        self.filters.append(tag)
        return tag

    def query_sandboxes(self, query: tuple[str, str], project_id: str) -> Iterator[_ListedBox]:
        """List the boxes."""
        return iter(self.boxes)


class _Api:
    """Fake ``vercel.api`` whose session is a no-op context."""

    def __init__(self) -> None:
        """Start with no recorded options."""
        self.service_options: Any = None

    @contextlib.contextmanager
    def session(self, service_options: Any = None) -> Iterator[None]:
        """Record the service options and yield."""
        self.service_options = service_options
        yield


def test_stop_job_sandboxes_stops_only_the_live_boxes_under_the_job_tag(monkeypatch: pytest.MonkeyPatch) -> None:
    """Pending and running boxes get stopped, finished ones are skipped and one refusal does not end the sweep."""
    boxes = [
        _ListedBox("a", "running"),
        _ListedBox("b", "stopped"),
        _ListedBox("c", "pending", fail=True),
        _ListedBox("d", "running"),
    ]
    fake_sync = _QuerySync(boxes)
    api = _Api()
    monkeypatch.setattr(sandbox_mod, "vercel_sync", fake_sync)
    monkeypatch.setattr(sandbox_mod, "vercel_api", api)
    runtime = VercelSandboxRuntime(VercelCredentials(token="t", team_id="team", project_id="proj"), image="img")

    stopped = runtime.stop_job_sandboxes("job-1")

    assert stopped == 2
    assert [box.stopped for box in boxes] == [True, False, False, True]
    assert fake_sync.filters == [(JOB_TAG, "job-1")]
    assert fake_sync.credentials == {"token": "t", "team_id": "team", "project_id": "proj"}
    assert api.service_options == ["options"]
