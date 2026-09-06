"""Verify package capability boundaries and immutable wheel downloads."""

from __future__ import annotations

import hashlib
import json

import pytest

from ..package_broker import PackageBroker


def test_index_only_registers_hashed_wheels_and_checks_artifacts(monkeypatch: pytest.MonkeyPatch) -> None:
    """Expose only wheel artifacts advertised for the requested package.

    Args:
        monkeypatch: Fixture replacing external HTTP with exact registry responses.
    """
    data = b"example wheel"
    digest = hashlib.sha256(data).hexdigest()
    wheel = "example-1.2-py3-none-any.whl"
    requests = []

    async def fetch(self: PackageBroker, url: str, limit: int) -> bytes:
        """Serve a tiny synthetic registry.

        Args:
            self: Broker under test.
            url: Requested index or wheel URL.
            limit: Bounded response allowance.

        Returns:
            Controlled index HTML or wheel bytes.
        """
        requests.append(url)
        if url.endswith("/example/"):
            return (
                f'<a href="https://files.example/{wheel}#sha256={digest}">{wheel}</a>'
                '<a href="https://files.example/example-1.0.tar.gz">source</a>'
            ).encode()
        return data

    monkeypatch.setattr(PackageBroker, "_fetch", fetch)
    broker = PackageBroker("https://packages.example/simple", check_admission=lambda: None)
    index = json.loads(broker.dispatch({"action": "index", "project": "example"}).body)
    assert [artifact["filename"] for artifact in index["artifacts"]] == [wheel]
    chunk = json.loads(broker.dispatch({"action": "wheel", "sha256": digest}).body)
    assert chunk["size"] == len(data)
    assert requests == ["https://packages.example/simple/example/", f"https://files.example/{wheel}"]
    with pytest.raises(ValueError, match="Unknown package"):
        broker.dispatch({"action": "wheel", "sha256": "f" * 64})
    with pytest.raises(ValueError, match="Invalid package name"):
        broker.dispatch({"action": "index", "project": "../../admin"})


def test_locked_capability_cannot_resolve_other_packages() -> None:
    """Refuse arbitrary index queries once execution is bound to a wheel lock."""
    broker = PackageBroker("https://pypi.org/simple", check_admission=lambda: None, artifacts=[])
    with pytest.raises(ValueError, match="Unsupported package operation"):
        broker.dispatch({"action": "index", "project": "unrequested"})


def test_corrupted_wheel_is_rejected(monkeypatch: pytest.MonkeyPatch) -> None:
    """Require a full content hash match before returning any artifact bytes.

    Args:
        monkeypatch: Fixture replacing the wheel fetch with modified content.
    """

    async def fetch(self: PackageBroker, url: str, limit: int) -> bytes:
        """Return corrupted content.

        Args:
            self: Broker under test.
            url: Requested wheel URL.
            limit: Download size allowance.

        Returns:
            Content different from the locked digest.
        """
        return b"modified"

    monkeypatch.setattr(PackageBroker, "_fetch", fetch)
    broker = PackageBroker(
        "https://pypi.org/simple",
        check_admission=lambda: None,
        artifacts=[
            {
                "filename": "example-1.0-py3-none-any.whl",
                "url": "https://files.example/example.whl",
                "sha256": "0" * 64,
            }
        ],
    )
    with pytest.raises(ValueError, match="integrity"):
        broker.dispatch({"action": "wheel", "sha256": "0" * 64})
