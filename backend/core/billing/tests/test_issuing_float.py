"""Tests for the Stripe Issuing funding loop.

Covers the enable gate, the no-op above the floor (pending top-ups included),
the payments-balance transfer first, the bank top-up fallback when the
transfer beta is missing, the alert on a failed top-up or balance read, and
the sweeper's gate and failure swallowing. A fake Stripe client stands in for
the network.
"""

from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import Mock

import pytest
import stripe
from pydantic import SecretStr

from core.billing import issuing_float
from core.billing.issuing_float import (
    IssuingFundingSweeper,
    fund_issuing_once,
    funding_enabled,
    start_issuing_funding_sweeper,
)
from core.config import settings


def _topup(amount: int, *, ours: bool = True) -> SimpleNamespace:
    """Build a pending top-up as the Stripe list returns it."""
    return SimpleNamespace(amount=amount, currency="usd", metadata={"skynet_purpose": "issuing_float"} if ours else {})


def _client(*, issuing: int, payments: int, pending: list[SimpleNamespace] | None = None) -> Mock:
    """Build a fake Stripe client with the given balances and pending top-ups."""
    client = Mock()
    client.v1.balance.retrieve.return_value = {
        "available": [{"amount": payments, "currency": "usd"}],
        "issuing": {"available": [{"amount": issuing, "currency": "usd"}]},
    }
    client.v1.topups.list.return_value = SimpleNamespace(data=pending or [])
    return client


@pytest.fixture
def funding_on(monkeypatch: pytest.MonkeyPatch) -> None:
    """Enable the loop with a $50 floor and a $150 target."""
    monkeypatch.setattr(settings, "stripe_secret_key", SecretStr("sk_test_x"))
    monkeypatch.setattr(settings, "issuing_balance_floor_credits", 5000)
    monkeypatch.setattr(settings, "issuing_balance_target_credits", 15000)
    monkeypatch.setattr(settings, "openrouter_float_alert_cooldown_seconds", 0)


@pytest.fixture
def alerts(monkeypatch: pytest.MonkeyPatch) -> Mock:
    """Capture operator alerts instead of sending them."""
    sent = Mock()
    monkeypatch.setattr(issuing_float, "send_alert", sent)
    return sent


def _use(monkeypatch: pytest.MonkeyPatch, client: Mock) -> None:
    """Route the module's Stripe client to ``client``."""
    monkeypatch.setattr(issuing_float, "_client", lambda: client)


def test_funding_disabled_without_a_target_above_the_floor(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(settings, "stripe_secret_key", SecretStr("sk_test_x"))
    monkeypatch.setattr(settings, "issuing_balance_floor_credits", 5000)
    monkeypatch.setattr(settings, "issuing_balance_target_credits", 5000)
    assert not funding_enabled()
    assert fund_issuing_once() is None
    assert start_issuing_funding_sweeper(None) is None


@pytest.mark.usefixtures("funding_on")
def test_no_funding_when_balance_and_pending_clear_the_floor(monkeypatch: pytest.MonkeyPatch) -> None:
    client = _client(issuing=2000, payments=90000, pending=[_topup(4000), _topup(9999, ours=False)])
    _use(monkeypatch, client)
    result = fund_issuing_once()
    assert result is not None
    assert (result.issuing_credits, result.pending_credits) == (2000, 4000)
    client.raw_request.assert_not_called()
    client.v1.topups.create.assert_not_called()


@pytest.mark.usefixtures("funding_on")
def test_shortfall_comes_from_payments_balance_first(monkeypatch: pytest.MonkeyPatch, alerts: Mock) -> None:
    client = _client(issuing=1000, payments=90000)
    _use(monkeypatch, client)
    result = fund_issuing_once()
    assert result is not None
    assert result.transferred_credits == 14000
    assert result.topped_up_credits == 0
    args, kwargs = client.raw_request.call_args
    assert args == ("post", "/v1/balance_transfers")
    assert kwargs["amount"] == 14000
    assert kwargs["source_balance"] == {"type": "payments"}
    assert kwargs["destination_balance"] == {"type": "issuing"}
    client.v1.topups.create.assert_not_called()
    alerts.assert_not_called()


@pytest.mark.usefixtures("funding_on")
def test_bank_top_up_covers_what_payments_cannot(monkeypatch: pytest.MonkeyPatch) -> None:
    client = _client(issuing=1000, payments=4000)
    _use(monkeypatch, client)
    result = fund_issuing_once(now=7200.0)
    assert result is not None
    assert result.transferred_credits == 4000
    assert result.topped_up_credits == 10000
    params, options = client.v1.topups.create.call_args.args
    assert params["amount"] == 10000
    assert params["destination_balance"] == "issuing"
    assert options == {"idempotency_key": "skynet-issuing-topup-2-10000"}


@pytest.mark.usefixtures("funding_on")
def test_missing_transfer_beta_falls_back_to_the_bank(monkeypatch: pytest.MonkeyPatch) -> None:
    client = _client(issuing=0, payments=90000)
    client.raw_request.side_effect = stripe.InvalidRequestError("Unrecognized request URL", None)
    _use(monkeypatch, client)
    result = fund_issuing_once()
    assert result is not None
    assert result.transferred_credits == 0
    assert result.topped_up_credits == 15000


@pytest.mark.usefixtures("funding_on")
def test_failed_top_up_alerts_the_operator(monkeypatch: pytest.MonkeyPatch, alerts: Mock) -> None:
    client = _client(issuing=0, payments=0)
    client.v1.topups.create.side_effect = stripe.InvalidRequestError("No bank account", None)
    _use(monkeypatch, client)
    result = fund_issuing_once()
    assert result is not None
    assert result.topped_up_credits == 0
    assert result.error is not None
    assert "No bank account" in result.error
    client.raw_request.assert_not_called()
    alerts.assert_called_once()


@pytest.mark.usefixtures("funding_on")
def test_unreadable_balance_alerts_and_returns_none(monkeypatch: pytest.MonkeyPatch, alerts: Mock) -> None:
    client = Mock()
    client.v1.balance.retrieve.side_effect = stripe.AuthenticationError("bad key")
    _use(monkeypatch, client)
    assert fund_issuing_once() is None
    alerts.assert_called_once()


@pytest.mark.usefixtures("funding_on")
def test_sweeper_swallows_unexpected_errors(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(issuing_float, "fund_issuing_once", Mock(side_effect=RuntimeError("boom")))
    assert IssuingFundingSweeper(None).sweep_once() is None


@pytest.mark.usefixtures("funding_on")
def test_sweeper_not_started_when_interval_is_zero(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(settings, "issuing_funding_check_interval_seconds", 0)
    assert start_issuing_funding_sweeper(None) is None
