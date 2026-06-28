"""Tests for the metered-overage seam of ``StripeBillingService``.

Covers ``report_run_usage`` (whether/with-what-units a meter event is pushed) and
``create_subscription_checkout`` (whether the metered price rides on the
subscription). Each test stands up an in-memory SQLite engine with the billing
tables and patches the ``stripe`` module so no network call is made.
"""

from __future__ import annotations

from collections.abc import Iterator
from types import SimpleNamespace
from unittest.mock import patch

import pytest
from pydantic import SecretStr
from sqlalchemy import create_engine
from sqlalchemy.orm import Session

from core.billing.service import METER_UNIT_TOKENS, StripeBillingService
from core.config import settings
from core.storage.models import Base, BillingCustomerModel


@pytest.fixture
def engine() -> Iterator[object]:
    """Yield an in-memory SQLite engine with the billing tables created."""
    eng = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(eng)
    yield eng
    Base.metadata.drop_all(eng)


@pytest.fixture
def configured(monkeypatch: pytest.MonkeyPatch) -> None:
    """Set a fake Stripe secret key so mutations are not short-circuited."""
    monkeypatch.setattr(settings, "stripe_secret_key", SecretStr("sk_test_dummy"))


def _seed_customer(engine: object, username: str) -> None:
    """Insert a billing customer row so the account is metered-eligible.

    Args:
        engine: The SQLite engine to write to.
        username: Account identity to create a Stripe-customer link for.
    """
    with Session(engine) as session:
        session.add(
            BillingCustomerModel(
                username=username, stripe_customer_id=f"cus_{username}", credit_balance=0
            )
        )
        session.commit()


def test_report_run_usage_noop_when_stripe_unconfigured(
    engine: object, monkeypatch: pytest.MonkeyPatch
) -> None:
    """No meter event is pushed when no Stripe secret key is configured."""
    monkeypatch.setattr(settings, "stripe_secret_key", None)
    _seed_customer(engine, "u@x.com")
    service = StripeBillingService(engine=engine)
    with patch("stripe.billing.MeterEvent.create") as create:
        service.report_run_usage("u@x.com", 5000)
    create.assert_not_called()


def test_report_run_usage_noop_without_billing_customer(engine: object, configured: None) -> None:
    """Usage for an account that never touched billing is not metered (no customer sprawl)."""
    service = StripeBillingService(engine=engine)
    with patch("stripe.billing.MeterEvent.create") as create:
        service.report_run_usage("nobody@x.com", 5000)
    create.assert_not_called()
    with Session(engine) as session:
        assert session.get(BillingCustomerModel, "nobody@x.com") is None


def test_report_run_usage_noop_below_one_unit(engine: object, configured: None) -> None:
    """A run smaller than one meter unit reports nothing rather than rounding up."""
    _seed_customer(engine, "u@x.com")
    service = StripeBillingService(engine=engine)
    with patch("stripe.billing.MeterEvent.create") as create:
        service.report_run_usage("u@x.com", METER_UNIT_TOKENS - 1)
    create.assert_not_called()


def test_report_run_usage_meters_whole_units_for_customer(engine: object, configured: None) -> None:
    """Tokens are floored to whole meter units and pushed for the right customer."""
    _seed_customer(engine, "u@x.com")
    service = StripeBillingService(engine=engine)
    with patch("stripe.billing.MeterEvent.create") as create:
        service.report_run_usage("u@x.com", 2 * METER_UNIT_TOKENS + 500)
    create.assert_called_once()
    kwargs = create.call_args.kwargs
    assert kwargs["event_name"] == settings.stripe_meter_event_name
    assert kwargs["payload"]["stripe_customer_id"] == "cus_u@x.com"
    assert kwargs["payload"]["value"] == "2"


def test_subscription_checkout_includes_metered_item(
    engine: object, configured: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A configured metered price rides on the subscription as a quantity-less item."""
    monkeypatch.setattr(settings, "stripe_price_premium", "price_premium")
    monkeypatch.setattr(settings, "stripe_price_metered", "price_metered")
    _seed_customer(engine, "u@x.com")
    service = StripeBillingService(engine=engine)
    with patch("stripe.checkout.Session.create") as create:
        create.return_value = SimpleNamespace(url="https://checkout.test/abc")
        url = service.create_subscription_checkout("u@x.com")
    assert url == "https://checkout.test/abc"
    assert create.call_args.kwargs["line_items"] == [
        {"price": "price_premium", "quantity": 1},
        {"price": "price_metered"},
    ]


def test_subscription_checkout_omits_metered_when_unconfigured(
    engine: object, configured: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    """With no metered price configured, only the flat Premium item is sent."""
    monkeypatch.setattr(settings, "stripe_price_premium", "price_premium")
    monkeypatch.setattr(settings, "stripe_price_metered", "")
    _seed_customer(engine, "u@x.com")
    service = StripeBillingService(engine=engine)
    with patch("stripe.checkout.Session.create") as create:
        create.return_value = SimpleNamespace(url="https://checkout.test/abc")
        service.create_subscription_checkout("u@x.com")
    assert create.call_args.kwargs["line_items"] == [{"price": "price_premium", "quantity": 1}]
