"""Verify placeholder billing customer ids fit the column for any username length.

``billing_customers.stripe_customer_id`` is ``String(64)``. SQLite does not
enforce that width, so each test asserts the stored length directly; PostgreSQL
rejects a longer value with ``StringDataRightTruncation``.
"""

from __future__ import annotations

from collections.abc import Iterator
from types import SimpleNamespace

import pytest
from sqlalchemy import Engine, create_engine
from sqlalchemy.orm import Session

from core.billing.budgets import BudgetService
from core.billing.pricing import ModelUsage
from core.billing.service import LOCAL_CUSTOMER_PREFIX, StripeBillingService, local_customer_id
from core.config import settings
from core.storage.models import Base, BillingCustomerModel

COLUMN_WIDTH = 64
DOMAIN = "@eegeupelae.resend.app"
USERNAME_61 = "a" * (61 - len(DOMAIN)) + DOMAIN
USERNAME_255 = "b" * (255 - len(DOMAIN)) + DOMAIN
LONG_USERNAMES = [USERNAME_61, USERNAME_255]


@pytest.fixture
def engine() -> Iterator[Engine]:
    """Yield an in-memory SQLite engine with the billing tables created."""
    database = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(database)
    yield database
    database.dispose()


@pytest.fixture
def preview_grant(monkeypatch: pytest.MonkeyPatch) -> None:
    """Give new accounts the PR-preview grant so a budget can be funded without a top-up."""
    monkeypatch.setattr(settings, "railway_environment_name", "skynet-pr-107")
    monkeypatch.setattr(settings, "preview_grant_cents", 1000)


def _stored_id(engine: Engine, username: str) -> str:
    """Read the persisted ``stripe_customer_id`` of an account.

    Args:
        engine: Database holding the billing row.
        username: Account whose row to read.

    Returns:
        The stored customer id.
    """
    with Session(engine) as session:
        row = session.get(BillingCustomerModel, username)
        assert row is not None
        return row.stripe_customer_id


def _assert_fits(customer_id: str) -> None:
    """Check that a placeholder id keeps the local prefix and fits the column.

    Args:
        customer_id: Stored ``stripe_customer_id`` value.
    """
    assert customer_id.startswith(LOCAL_CUSTOMER_PREFIX)
    assert len(customer_id) <= COLUMN_WIDTH


def test_fixture_usernames_exceed_the_old_limit() -> None:
    """The fixtures are long enough that ``local:`` plus the raw username overflowed."""
    assert [len(name) for name in LONG_USERNAMES] == [61, 255]
    assert all(len(f"{LOCAL_CUSTOMER_PREFIX}{name}") > COLUMN_WIDTH for name in LONG_USERNAMES)


@pytest.mark.parametrize("username", LONG_USERNAMES)
def test_budget_creation_seeds_a_wallet_for_a_long_username(engine: Engine, preview_grant: None, username: str) -> None:
    """``BudgetService._wallet`` creates a fitting row when a new account funds a budget."""
    budget = BudgetService(engine=engine).create(username, 100, idempotency_key="first")

    assert budget.total_cents == 100
    _assert_fits(_stored_id(engine, username))


@pytest.mark.parametrize("username", LONG_USERNAMES)
def test_run_debit_seeds_a_wallet_for_a_long_username(engine: Engine, username: str) -> None:
    """``debit_run`` creates a fitting row for an account that never reached Stripe."""
    StripeBillingService(engine=engine).debit_run(
        username,
        [ModelUsage(model="unpriced/model", input_tokens=1, output_tokens=1)],
        model=None,
        description="run",
    )

    _assert_fits(_stored_id(engine, username))


@pytest.mark.parametrize("username", LONG_USERNAMES)
def test_clawback_seeds_a_wallet_for_a_long_username(engine: Engine, username: str) -> None:
    """``_write_clawback`` creates a fitting row when a refund names an unknown account."""
    service = StripeBillingService(engine=engine)
    with Session(engine) as session:
        service._write_clawback(
            session,
            event_id="evt_test",
            payment_intent="pi_test",
            username=username,
            cents=50,
            kind="refund",
            description="Refund",
        )
        session.commit()

    _assert_fits(_stored_id(engine, username))


def test_long_usernames_sharing_a_prefix_get_different_ids() -> None:
    """Usernames equal in their first 58 characters still map to distinct ids."""
    stem = "c" * 58
    first, second = f"{stem}-one{DOMAIN}", f"{stem}-two{DOMAIN}"

    assert local_customer_id(first) != local_customer_id(second)
    assert local_customer_id(first) == local_customer_id(first)


def test_two_long_accounts_each_get_a_row(engine: Engine, preview_grant: None) -> None:
    """The unique index accepts two long accounts that share a 58-character prefix."""
    stem = "d" * 58
    names = [f"{stem}-one{DOMAIN}", f"{stem}-two{DOMAIN}"]
    service = BudgetService(engine=engine)
    for name in names:
        service.create(name, 100, idempotency_key="first")

    ids = [_stored_id(engine, name) for name in names]
    assert ids[0] != ids[1]


def test_existing_short_local_row_still_counts_as_customerless(engine: Engine, monkeypatch: pytest.MonkeyPatch) -> None:
    """A legacy ``local:<username>`` row passes the prefix checks and upgrades to a real id."""
    with Session(engine) as session:
        session.add(BillingCustomerModel(username="old@x.com", stripe_customer_id="local:old@x.com", balance_cents=7))
        session.commit()
    service = StripeBillingService(engine=engine)
    customer_api = SimpleNamespace(create=lambda **_: SimpleNamespace(id="cus_real"))
    monkeypatch.setattr(service, "_stripe", lambda: SimpleNamespace(Customer=customer_api))

    assert service._existing_customer_id("old@x.com") is None
    assert service.get_or_create_customer("old@x.com") == "cus_real"
    with Session(engine) as session:
        row = session.get(BillingCustomerModel, "old@x.com")
        assert row is not None
        assert (row.stripe_customer_id, row.balance_cents) == ("cus_real", 7)
