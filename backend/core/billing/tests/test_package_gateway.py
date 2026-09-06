"""Verify package tokens cannot invoke other protected parent capabilities."""

from __future__ import annotations

import json

import httpx
import pytest

from ..model_gateway import ModelGateway
from ..package_broker import PackageBroker
from .test_model_gateway_transport import gateway as gateway_fixture

gateway = gateway_fixture


def test_package_token_is_scoped(gateway: ModelGateway, monkeypatch: pytest.MonkeyPatch) -> None:
    """Allow registry metadata but reject model dispatch with the package-only token.

    Args:
        gateway: Funded real HTTP gateway fixture.
        monkeypatch: Fixture replacing only external registry traffic.
    """

    async def fetch(self: PackageBroker, url: str, limit: int) -> bytes:
        """Return an empty registry index.

        Args:
            self: Package capability under test.
            url: Requested registry URL.
            limit: Allowed response size.

        Returns:
            Empty HTML index.
        """
        return b"<html></html>"

    monkeypatch.setattr(PackageBroker, "_fetch", fetch)
    payload = gateway.protect_payload(
        {
            "scorer": {"kind": "python", "metric_code": "import example"},
            "dependency_registry": "https://pypi.org/simple",
        },
        managed_key="fixture",
    )
    token = payload["_skynet_packages_route"]["token"]
    response = gateway.dispatch_guest(token, "/v1/_packages", {"action": "index", "project": "example"}, {})
    assert json.loads(response.body) == {"artifacts": []}
    with pytest.raises(ValueError):
        gateway.dispatch_guest(token, "/v1/chat/completions", {"model": "fixture/text"}, {})
    response = httpx.post(gateway.url + "/chat/completions", headers={"Authorization": "Bearer " + token}, json={})
    assert response.status_code == 401
