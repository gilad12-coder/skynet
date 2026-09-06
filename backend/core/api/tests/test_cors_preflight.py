"""Verify browser authorization for idempotent wizard requests."""

from __future__ import annotations

import pytest

from core.config import settings

from .test_app_integration import app_client as _app_client
from .test_app_integration import mock_job_store as _mock_job_store
from .test_app_integration import mock_worker as _mock_worker

app_client = _app_client
mock_job_store = _mock_job_store
mock_worker = _mock_worker


@pytest.fixture(autouse=True)
def allowed_origin(monkeypatch: pytest.MonkeyPatch) -> None:
    """Configure one explicit frontend origin for each browser-policy test.

    Args:
        monkeypatch: Fixture restoring the production settings after the test.
    """
    monkeypatch.setattr(settings, "cors_origins", "http://localhost:3000")


@pytest.mark.parametrize("path", ["/execution-budgets", "/wizard/preflight", "/blackbox/run"])
def test_browser_can_send_idempotent_wizard_requests(app_client, path: str) -> None:
    """Allow the exact headers used by Continue without invoking paid execution.

    Args:
        app_client: Real app factory with external services replaced by fixtures.
        path: Budget, setup, or submission endpoint requested by the browser.
    """
    client, _, _ = app_client
    response = client.options(
        path,
        headers={
            "Origin": "http://localhost:3000",
            "Access-Control-Request-Method": "POST",
            "Access-Control-Request-Headers": "authorization,content-type,idempotency-key",
        },
    )
    assert response.status_code == 200, response.text
    assert response.headers["access-control-allow-origin"] == "http://localhost:3000"
    assert "idempotency-key" in response.headers["access-control-allow-headers"].lower()


def test_idempotency_header_does_not_allow_foreign_origins(app_client) -> None:
    """Keep the origin restriction when authorizing retry-safe requests.

    Args:
        app_client: Real app factory with external services replaced by fixtures.
    """
    client, _, _ = app_client
    response = client.options(
        "/execution-budgets",
        headers={
            "Origin": "https://untrusted.example",
            "Access-Control-Request-Method": "POST",
            "Access-Control-Request-Headers": "authorization,content-type,idempotency-key",
        },
    )
    assert response.status_code == 400
    assert "access-control-allow-origin" not in response.headers
