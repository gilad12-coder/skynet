"""The setup check words its contract failure in the caller's language, English by default."""

from __future__ import annotations

import json
from decimal import Decimal
from typing import Any

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from core.api.auth import AuthenticatedUser, get_authenticated_user
from core.api.preflight_execution import WizardPreflightCheck, WizardPreflightResponse
from core.api.routers import wizard_preflight
from core.api.routers.execution_budgets import ExecutionBudgetResponse
from core.i18n import request_locale, t, t_locale

RUN_CODE = "def run(artifact, input):\n    return artifact\n"
METRIC_CODE = "def score(input, output, expected=None):\n    return 1.0, {'feedback': 'ok'}\n"
ERROR = "SyntaxError: invalid syntax"
TRACE = 'File "metric.py", line 1\n    def score(:\n' + ERROR


def _spec() -> dict[str, Any]:
    """Build a unified spec as the wizard sends it."""
    return {
        "task": {"objective": "o", "artifact": {"kind": "prompt", "starting_version": "p"}},
        "data": {
            "mode": "pairs",
            "cases": [{"input": {"q": str(i)}, "expected": "p"} for i in range(3)],
            "input_fields": ["q"],
        },
        "optimizer": {"choice": "best_of_n"},
        "models": {"reflection_model": {"name": "openrouter/task"}},
        "workspace": {"run_code": RUN_CODE, "metric_code": METRIC_CODE},
    }


def _budget() -> ExecutionBudgetResponse:
    """Build a budget snapshot for the response."""
    zero = Decimal(0)
    return ExecutionBudgetResponse(
        id="b1",
        total_cents=100,
        uncapped=False,
        revision=1,
        generation=1,
        state="draft",
        job_id=None,
        setup_spent_cents=zero,
        run_spent_cents=zero,
        reserved_cents=zero,
        available_cents=Decimal(100),
        billed_cents=0,
        wallet_setup_spent_cents=zero,
        wallet_run_spent_cents=zero,
        wallet_reserved_cents=0,
        account_available_cents=100,
        external_spent_cents=zero,
        pending_operations=0,
        blocked_reason=None,
    )


def _failed_sample(*, coded: bool) -> dict[str, Any]:
    """Build the failed metric sample the sandbox reports, with or without its code.

    Args:
        coded: Whether the sandbox's backend already sends ``message_code``.

    Returns:
        One contract check item as JSON.
    """
    params = {"index": 1, "error": ERROR}
    item: dict[str, Any] = {
        "key": "metric.shape",
        "status": "failed",
        "message": t("contract.metric_error", **params),
        "sample_index": 0,
        "detail": TRACE,
    }
    if coded:
        item.update(message_code="contract.metric_error", message_params=params)
    return item


@pytest.fixture
def stored(monkeypatch: pytest.MonkeyPatch) -> dict[str, Any]:
    """Answer every setup check with a failed contract worded in the Hebrew base.

    Args:
        monkeypatch: Replaces the paid setup work.

    Returns:
        The sample the stored contract reports; tests may edit it before calling.
    """
    sample = _failed_sample(coded=True)

    def run(request: Any, user: Any, store: Any) -> WizardPreflightResponse:
        """Return what the sandbox check stored, as the real path does."""
        return WizardPreflightResponse(
            id="p1",
            fingerprint="f",
            status="failed",
            may_advance=False,
            checks=[
                WizardPreflightCheck(
                    key="metric.contract",
                    status="failed",
                    message=f"{sample['message']}\n{TRACE}",
                    field="workspace",
                )
            ],
            budget=_budget(),
            workflow_result={
                "contract": {
                    "ok": False,
                    "optimizer_resolved": "best_of_n",
                    "checks": [sample],
                    "samples": [],
                    "fingerprint": "f",
                }
            },
        )

    monkeypatch.setattr(wizard_preflight, "run_preflight", run)
    monkeypatch.setattr(wizard_preflight, "enforce_submission_rate", lambda username: None)
    monkeypatch.setattr(wizard_preflight, "_materialize_unified_cases", lambda *args, **kwargs: None)
    return sample


def _body(**extra: Any) -> dict[str, Any]:
    """Build a unified evaluation setup check request."""
    return {
        "scope": "evaluation",
        "workflow": "unified",
        "payload": _spec(),
        "execution_budget_id": "b1",
        "execution_budget_revision": 1,
        **extra,
    }


def _post(path: str, body: dict[str, Any], headers: dict[str, str] | None = None) -> Any:
    """Send one setup check as a signed-in user.

    Args:
        path: Route to call.
        body: Request body.
        headers: Extra request headers.

    Returns:
        The HTTP response.
    """
    app = FastAPI()
    app.include_router(wizard_preflight.create_wizard_preflight_router(job_store=object()))
    app.dependency_overrides[get_authenticated_user] = lambda: AuthenticatedUser("alice", "user", ())
    with TestClient(app) as client:
        # TestClient sends no Accept-Language unless a test sets one.
        return client.post(path, json=body, headers=headers or {})


def _contract_check(payload: dict[str, Any]) -> dict[str, Any]:
    """Return the ``metric.contract`` check of a setup check response."""
    return next(check for check in payload["checks"] if check["key"] == "metric.contract")


def test_english_account_without_accept_language_reads_english(stored: dict[str, Any]) -> None:
    """With no locale and no ``Accept-Language`` the failure reads in English, not Hebrew."""
    response = _post("/wizard/preflight", _body())

    assert response.status_code == 200
    check = _contract_check(response.json())
    english = t_locale("en", "contract.metric_error", index=1, error=ERROR)
    assert english != t("contract.metric_error", index=1, error=ERROR)
    assert check["message"] == f"{english}\n{TRACE}"
    assert check["message_code"] == "contract.metric_error"
    assert check["message_params"] == {"index": 1, "error": ERROR}


def test_ui_locale_wins_over_the_browser_language(stored: dict[str, Any]) -> None:
    """An English UI in a Hebrew browser still reads English."""
    response = _post("/wizard/preflight", _body(locale="en"), headers={"Accept-Language": "he-IL,he;q=0.9"})

    english = t_locale("en", "contract.metric_error", index=1, error=ERROR)
    assert _contract_check(response.json())["message"] == f"{english}\n{TRACE}"


def test_accept_language_is_used_when_the_body_names_no_locale(stored: dict[str, Any]) -> None:
    """A Hebrew ``Accept-Language`` with no body locale keeps the Hebrew wording."""
    response = _post("/wizard/preflight", _body(), headers={"Accept-Language": "he"})

    hebrew = t("contract.metric_error", index=1, error=ERROR)
    assert _contract_check(response.json())["message"] == f"{hebrew}\n{TRACE}"


def test_an_uncoded_sandbox_failure_is_recovered_and_worded_in_english(stored: dict[str, Any]) -> None:
    """An older sandbox image sends no message code; the host recovers it from the Hebrew text."""
    stored.clear()
    stored.update(_failed_sample(coded=False))

    check = _contract_check(_post("/wizard/preflight", _body()).json())

    assert check["message_code"] == "contract.metric_error"
    assert check["message"].startswith(t_locale("en", "contract.metric_error", index=1, error=ERROR))


def test_stream_result_reads_english_without_accept_language(stored: dict[str, Any]) -> None:
    """The streaming setup check words its final result the same way."""
    response = _post("/wizard/preflight/stream", _body())

    frames = [
        json.loads(line.removeprefix("data: ")) for line in response.text.splitlines() if line.startswith("data: ")
    ]
    result = frames[-1]
    english = t_locale("en", "contract.metric_error", index=1, error=ERROR)
    assert _contract_check(result)["message"] == f"{english}\n{TRACE}"


@pytest.mark.parametrize(
    ("explicit", "header", "expected"),
    [
        (None, None, "en"),
        ("", "", "en"),
        ("fr-CA", "he", "fr-CA"),
        (None, "he-IL,he;q=0.9,en;q=0.8", "he-IL"),
        (None, "en;q=0.5, ar;q=0.9", "ar"),
        (None, "*, de;q=0", "en"),
        ("not a tag!", "pt-BR", "pt-BR"),
    ],
)
def test_request_locale_prefers_the_ui_then_the_browser_then_english(
    explicit: str | None, header: str | None, expected: str
) -> None:
    """The body locale wins, then the best-ranked browser language, then English."""
    assert request_locale(explicit, header) == expected
