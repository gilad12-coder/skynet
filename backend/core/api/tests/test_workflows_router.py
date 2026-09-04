"""Verify workflow preview validation never falls back to authored code in the API host."""

from __future__ import annotations

from unittest.mock import patch

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from ..routers.workflows import create_workflows_router
from .conftest import bypass_auth


@pytest.fixture
def workflows_client() -> TestClient:
    """Build a deliberately unconfigured preview API to verify isolation admission."""
    app = FastAPI()
    app.include_router(create_workflows_router())
    bypass_auth(app)
    return TestClient(app, raise_server_exceptions=False)


def _payload() -> dict:
    """Provide one actual authored transform and explicit debug inputs."""
    return {
        "workflow": {
            "nodes": [
                {"id": "in", "kind": "input", "fields": [{"name": "text"}]},
                {
                    "id": "transform",
                    "kind": "transform",
                    "transform_code": "def transform(text):\n    return {'answer': text.upper()}\n",
                    "input_fields": [{"name": "text"}],
                    "output_fields": [{"name": "answer"}],
                },
                {"id": "out", "kind": "output", "fields": [{"name": "answer"}]},
            ],
            "edges": [
                {"source": "in", "source_port": "text", "target": "transform", "target_port": "text"},
                {"source": "transform", "source_port": "answer", "target": "out", "target_port": "answer"},
            ],
        },
        "inputs": {"text": "explicit debug value"},
        "model_config": {"name": "fixture/model"},
    }


def test_dry_run_requires_protected_spending_authority(workflows_client: TestClient) -> None:
    """Reject missing billing/runtime authority without executing authored code on the host."""
    with patch("core.worker.preflight.run_workflow_preview") as guest:
        response = workflows_client.post("/workflows/dry-run", json=_payload())
    assert response.status_code == 503
    guest.assert_not_called()


@pytest.mark.parametrize("route", ["/workflows/dry-run", "/workflows/dry-run/stream"])
def test_dry_run_rejects_missing_inputs(workflows_client: TestClient, route: str) -> None:
    """Reject missing debug inputs using structural data before paid execution."""
    payload = _payload()
    payload["inputs"] = {}
    response = workflows_client.post(route, json=payload)
    assert response.status_code == 400
    assert "text" in response.text


def test_dry_run_rejects_structurally_invalid_graph(workflows_client: TestClient) -> None:
    """Reject an unwired graph during DTO validation before creating a budget."""
    payload = _payload()
    payload["workflow"]["edges"] = []
    response = workflows_client.post("/workflows/dry-run", json=payload)
    assert response.status_code == 422
