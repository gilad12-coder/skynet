"""Tests for ``StripeBillingService``: metered overage, the credit ledger, and gate.

Covers ``report_run_usage`` (whether/with-what-units a meter event is pushed),
``create_subscription_checkout`` (whether the metered price rides on the
subscription), and the Phase-0 credit-ledger backbone — ``credits_for_tokens``,
the rolling/non-cumulative free-grant reset, run debiting (grant before paid
balance), and the ``spendable_credits`` figure the submit gate reads. Each test
stands up an in-memory SQLite engine with the billing tables and patches the
``stripe`` module so no network call is made.
"""

from __future__ import annotations

from collections.abc import Iterator
from datetime import UTC, datetime, timedelta
from types import SimpleNamespace
from unittest.mock import patch

import pytest
from pydantic import SecretStr
from sqlalchemy import create_engine
from sqlalchemy.orm import Session

from core.billing.service import (
    FREE_GRANT_CREDITS,
    GRANT_WINDOW_DAYS,
    METER_UNIT_TOKENS,
    TOKENS_PER_CREDIT,
    StripeBillingService,
    credits_for_tokens,
)
from core.config import settings
from core.storage.models import Base, BillingCustomerModel, CreditLedgerModel


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


def _as_utc(value: datetime) -> datetime:
    """Coerce a possibly-naive timestamp to UTC (SQLite drops tzinfo on read).

    Args:
        value: A datetime read back from the SQLite billing tables.

    Returns:
        The same instant tagged UTC when it was naive.
    """
    return value if value.tzinfo is not None else value.replace(tzinfo=UTC)


def _grant_remaining(engine: object, username: str) -> int | None:
    """Read the persisted grant_remaining for an account.

    Args:
        engine: The SQLite engine to read from.
        username: Account whose grant column to read.

    Returns:
        The stored ``grant_remaining`` (``None`` when the row or column is unseeded).
    """
    with Session(engine) as session:
        customer = session.get(BillingCustomerModel, username)
        return None if customer is None else customer.grant_remaining


def test_credits_for_tokens_rounds_up_and_floors_at_zero() -> None:
    """A partial credit's tokens cost a whole credit; non-positive costs nothing."""
    assert credits_for_tokens(0) == 0
    assert credits_for_tokens(-10) == 0
    assert credits_for_tokens(1) == 1
    assert credits_for_tokens(TOKENS_PER_CREDIT) == 1
    assert credits_for_tokens(TOKENS_PER_CREDIT + 1) == 2
    assert credits_for_tokens(3 * TOKENS_PER_CREDIT) == 3


def test_wallet_reports_full_grant_for_new_account(engine: object) -> None:
    """A brand-new account reads a full grant without a row being created."""
    snapshot = StripeBillingService(engine=engine).get_wallet("new@x.com")
    assert snapshot.free_grant_remaining == FREE_GRANT_CREDITS
    assert snapshot.paid_balance_credits == 0
    with Session(engine) as session:
        assert session.get(BillingCustomerModel, "new@x.com") is None


def test_wallet_seeds_grant_window_on_first_read(engine: object) -> None:
    """Reading an existing row with no window seeds a full grant and a +30d anchor."""
    _seed_customer(engine, "u@x.com")
    before = datetime.now(UTC)
    snapshot = StripeBillingService(engine=engine).get_wallet("u@x.com")
    assert snapshot.free_grant_remaining == FREE_GRANT_CREDITS
    with Session(engine) as session:
        customer = session.get(BillingCustomerModel, "u@x.com")
    assert customer.grant_remaining == FREE_GRANT_CREDITS
    assert customer.grant_reset_at is not None
    expected = before + timedelta(days=GRANT_WINDOW_DAYS)
    assert abs((_as_utc(customer.grant_reset_at) - expected).total_seconds()) < 5


def test_debit_run_draws_from_grant_first(engine: object) -> None:
    """A run debit decrements the free grant before touching the paid balance."""
    _seed_customer(engine, "u@x.com")
    service = StripeBillingService(engine=engine)
    cost = service.debit_run(
        "u@x.com", 5 * TOKENS_PER_CREDIT, model="openai/gpt-5.5-mini", description="run-a"
    )
    assert cost == 5
    snapshot = service.get_wallet("u@x.com")
    assert snapshot.free_grant_remaining == FREE_GRANT_CREDITS - 5
    assert snapshot.paid_balance_credits == 0
    with Session(engine) as session:
        rows = session.query(CreditLedgerModel).filter_by(username="u@x.com").all()
    assert len(rows) == 1
    assert rows[0].delta_credits == -5
    assert rows[0].kind == "run"
    assert rows[0].model == "openai/gpt-5.5-mini"


def test_debit_run_overflows_grant_into_paid_balance(engine: object) -> None:
    """A debit larger than the remaining grant drains it, then the paid balance."""
    with Session(engine) as session:
        session.add(
            BillingCustomerModel(
                username="u@x.com",
                stripe_customer_id="cus_u",
                credit_balance=100,
                grant_remaining=10,
                grant_reset_at=datetime.now(UTC) + timedelta(days=GRANT_WINDOW_DAYS),
            )
        )
        session.commit()
    service = StripeBillingService(engine=engine)
    cost = service.debit_run("u@x.com", 30 * TOKENS_PER_CREDIT, model=None, description="big")
    assert cost == 30
    snapshot = service.get_wallet("u@x.com")
    assert snapshot.free_grant_remaining == 0
    assert snapshot.paid_balance_credits == 80


def test_debit_run_creates_local_row_for_customerless_account(engine: object) -> None:
    """A run for an account that never touched Stripe seeds a local billing row."""
    service = StripeBillingService(engine=engine)
    service.debit_run("free@x.com", 3 * TOKENS_PER_CREDIT, model=None, description="r")
    with Session(engine) as session:
        customer = session.get(BillingCustomerModel, "free@x.com")
    assert customer is not None
    assert customer.stripe_customer_id.startswith("local:")
    assert customer.grant_remaining == FREE_GRANT_CREDITS - 3


def test_debit_run_zero_cost_writes_nothing(engine: object) -> None:
    """A run under one credit's worth of tokens writes no ledger row or debit."""
    _seed_customer(engine, "u@x.com")
    service = StripeBillingService(engine=engine)
    assert service.debit_run("u@x.com", 0, model=None, description="r") == 0
    with Session(engine) as session:
        assert session.query(CreditLedgerModel).filter_by(username="u@x.com").count() == 0
        assert session.get(BillingCustomerModel, "u@x.com").grant_remaining in (None, FREE_GRANT_CREDITS)


def test_grant_reset_is_rolling_and_non_cumulative(engine: object) -> None:
    """Past the window the grant tops up to a flat 200; leftover does not bank."""
    past = datetime.now(UTC) - timedelta(days=1)
    with Session(engine) as session:
        session.add(
            BillingCustomerModel(
                username="u@x.com",
                stripe_customer_id="cus_u",
                credit_balance=0,
                grant_remaining=40,
                grant_reset_at=past,
            )
        )
        session.commit()
    service = StripeBillingService(engine=engine)
    snapshot = service.get_wallet("u@x.com")
    assert snapshot.free_grant_remaining == FREE_GRANT_CREDITS
    with Session(engine) as session:
        customer = session.get(BillingCustomerModel, "u@x.com")
    assert _as_utc(customer.grant_reset_at) > datetime.now(UTC)
    assert customer.grant_remaining == FREE_GRANT_CREDITS


def test_grant_does_not_reset_before_window_elapses(engine: object) -> None:
    """Inside the window the partially-spent grant is preserved (no early top-up)."""
    future = datetime.now(UTC) + timedelta(days=10)
    with Session(engine) as session:
        session.add(
            BillingCustomerModel(
                username="u@x.com",
                stripe_customer_id="cus_u",
                credit_balance=0,
                grant_remaining=40,
                grant_reset_at=future,
            )
        )
        session.commit()
    snapshot = StripeBillingService(engine=engine).get_wallet("u@x.com")
    assert snapshot.free_grant_remaining == 40
    assert _grant_remaining(engine, "u@x.com") == 40


def test_spendable_credits_sums_grant_and_paid_balance(engine: object) -> None:
    """The submit-gate figure is grant remaining plus purchased balance."""
    with Session(engine) as session:
        session.add(
            BillingCustomerModel(
                username="u@x.com",
                stripe_customer_id="cus_u",
                credit_balance=70,
                grant_remaining=30,
                grant_reset_at=datetime.now(UTC) + timedelta(days=GRANT_WINDOW_DAYS),
            )
        )
        session.commit()
    assert StripeBillingService(engine=engine).spendable_credits("u@x.com") == 100


def test_spendable_credits_zero_when_grant_and_balance_exhausted(engine: object) -> None:
    """A drained grant and zero paid balance reads as no spendable credits (gate trips)."""
    with Session(engine) as session:
        session.add(
            BillingCustomerModel(
                username="u@x.com",
                stripe_customer_id="cus_u",
                credit_balance=0,
                grant_remaining=0,
                grant_reset_at=datetime.now(UTC) + timedelta(days=GRANT_WINDOW_DAYS),
            )
        )
        session.commit()
    assert StripeBillingService(engine=engine).spendable_credits("u@x.com") == 0


def test_spendable_credits_full_for_new_account(engine: object) -> None:
    """A brand-new account has a full grant of spendable credits (gate passes)."""
    assert StripeBillingService(engine=engine).spendable_credits("new@x.com") == FREE_GRANT_CREDITS
