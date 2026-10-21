"""Tests for the Mac app's own notification channel (local mode only)."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import Session
from sqlalchemy.pool import StaticPool

from core.config import settings
from core.notifications import channels as channels_module
from core.notifications.catalog import CHANNELS, DEFAULT_GRID, MACOS
from core.notifications.channels import Delivery, EmailChannel, MacOSChannel, get_channel
from core.notifications.dispatch import notify
from core.notifications.native import CLAIM_BATCH, CLAIM_LEASE, claim_native, confirm_native
from core.notifications.preferences import configure_notification_preferences, default_grid, merge_grid

from ...storage.models import Base, NotificationModel, NotificationPreferenceModel

_USER = "local@skynet.local"
_T0 = datetime(2026, 10, 21, 12, 0, tzinfo=UTC)


@pytest.fixture
def engine():
    """Return an in-memory engine wired as the notification store.

    Returns:
        The engine.
    """
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    Base.metadata.create_all(engine, tables=[NotificationModel.__table__, NotificationPreferenceModel.__table__])
    configure_notification_preferences(engine)
    yield engine
    configure_notification_preferences(None)


@pytest.fixture
def local_mode(monkeypatch: pytest.MonkeyPatch) -> None:
    """Turn local mode on for one test.

    Args:
        monkeypatch: pytest's ``MonkeyPatch`` fixture.
    """
    monkeypatch.setattr(settings, "local_mode", True)


def _delivery(event_type: str = "finished") -> Delivery:
    """Build a delivery for the test user.

    Args:
        event_type: Catalog event type.

    Returns:
        The delivery.
    """
    return Delivery("n1", _USER, event_type, "opt-1", "Ticket triage", "/optimizations/opt-1")


def test_hosted_grid_has_no_macos_column() -> None:
    """Hosted mode keeps the hosted grid exactly."""
    assert default_grid() == DEFAULT_GRID
    assert merge_grid({"finished": {MACOS: True}}) == DEFAULT_GRID


def test_local_grid_adds_macos_with_the_push_defaults(local_mode: None) -> None:
    """Local mode adds a macOS column whose defaults follow Chrome push."""
    grid = default_grid()
    for event, row in DEFAULT_GRID.items():
        assert {k: v for k, v in grid[event].items() if k in CHANNELS} == row
        assert grid[event][MACOS] == row["chrome"]


def test_local_grid_keeps_stored_macos_cells_and_news_stays_inbox_only(local_mode: None) -> None:
    """A stored macOS cell wins, but product news never leaves the inbox."""
    grid = merge_grid({"finished": {MACOS: False}, "product_news": {MACOS: True}})
    assert grid["finished"][MACOS] is False
    assert grid["product_news"][MACOS] is False


def test_macos_channel_is_registered_and_off_in_hosted_mode() -> None:
    """The channel registers under ``macos`` and is unavailable outside local mode."""
    channel = get_channel(MACOS)
    assert isinstance(channel, MacOSChannel)
    assert channel.send(_delivery()) == "unavailable"


def test_macos_channel_queues_in_local_mode(local_mode: None) -> None:
    """In local mode the channel queues the notification for the Mac app."""
    assert MacOSChannel().send(_delivery()) == "queued"


def test_local_email_skips_the_placeholder_address(local_mode: None, monkeypatch: pytest.MonkeyPatch) -> None:
    """In the Mac app, mail to the default ``.local`` user address is never sent; it cannot arrive."""
    sent: list[str] = []
    monkeypatch.setattr(channels_module, "send_mail", lambda to, *a, **k: sent.append(to) or True)

    assert EmailChannel().send(_delivery()) == "unavailable"
    assert sent == []
    real = Delivery("n2", "qa@example.com", "finished", "opt-1", "Ticket triage", "/optimizations/opt-1")
    assert EmailChannel().send(real) == "sent"
    assert sent == ["qa@example.com"]


def test_hosted_email_still_sends_to_any_address(monkeypatch: pytest.MonkeyPatch) -> None:
    """Hosted mode keeps its email rule unchanged."""
    sent: list[str] = []
    monkeypatch.setattr(channels_module, "send_mail", lambda to, *a, **k: sent.append(to) or True)

    assert EmailChannel().send(_delivery()) == "sent"
    assert sent == [_USER]


def test_notify_queues_macos_at_once_in_local_mode(engine, local_mode: None) -> None:
    """A finished run is queued for macOS at once, never held, with the hosted channels kept."""
    notification_id = notify(_USER, "finished", "opt-1", {"score": 0.9}, title="Ticket triage", now=_T0)

    with Session(engine) as session:
        row = session.get(NotificationModel, notification_id)
        assert row is not None
        assert row.deliveries[MACOS]["state"] == "queued"
        assert row.deliveries["email"]["state"] == "held"
        assert "chrome" in row.deliveries


def test_notify_skips_macos_in_hosted_mode(engine) -> None:
    """Hosted routing never touches the macOS channel."""
    notification_id = notify(_USER, "finished", "opt-1", title="Ticket triage", now=_T0)

    with Session(engine) as session:
        row = session.get(NotificationModel, notification_id)
        assert row is not None
        assert MACOS not in row.deliveries


def test_notify_respects_a_macos_opt_out(engine, local_mode: None) -> None:
    """A user who turned the macOS cell off gets no native notification."""
    with Session(engine) as session:
        session.add(NotificationPreferenceModel(username=_USER, channel_grid={"finished": {MACOS: False}}))
        session.commit()

    notification_id = notify(_USER, "finished", "opt-1", title="Ticket triage", now=_T0)

    with Session(engine) as session:
        row = session.get(NotificationModel, notification_id)
        assert row is not None
        assert MACOS not in row.deliveries


def _macos_state(engine, notification_id: str) -> dict:
    """Return the stored macOS delivery of one notification.

    Args:
        engine: The test engine.
        notification_id: The notification row id.

    Returns:
        The ``deliveries["macos"]`` entry.
    """
    with Session(engine) as session:
        row = session.get(NotificationModel, notification_id)
        assert row is not None
        return row.deliveries[MACOS]


def test_claim_native_hands_each_queued_item_out_once(engine, local_mode: None) -> None:
    """A claim returns the queued items as display payloads and leases them; a confirm marks them sent."""
    first = notify(_USER, "finished", "opt-1", title="Ticket triage", now=_T0)
    second = notify(_USER, "failed", "opt-2", {"detail": "The sandbox stopped."}, title="Invoice parser", now=_T0)
    notify("someone@else.test", "finished", "opt-3", title="Not mine", now=_T0)

    claimed = claim_native(engine, _USER, now=_T0)

    assert [item.url for item in claimed] == ["/optimizations/opt-1", "/optimizations/opt-2"]
    assert claimed[0].id == first
    assert "Ticket triage" in claimed[0].title
    assert claimed[1].body == "The sandbox stopped."
    assert claimed[0].tag == "finished:opt-1"
    assert claim_native(engine, _USER, now=_T0) == []
    assert _macos_state(engine, first)["state"] == "claimed"

    assert confirm_native(engine, _USER, [first, second], now=_T0) == 2
    assert _macos_state(engine, first)["state"] == "sent"
    assert claim_native(engine, _USER, now=_T0 + CLAIM_LEASE * 2) == []


def test_claim_native_hands_out_again_when_the_app_never_confirms(engine, local_mode: None) -> None:
    """A claim whose answer was lost is handed out again once its lease ends, so nothing is lost."""
    notification_id = notify(_USER, "finished", "opt-1", title="Ticket triage", now=_T0)

    assert [item.id for item in claim_native(engine, _USER, now=_T0)] == [notification_id]
    assert claim_native(engine, _USER, now=_T0 + CLAIM_LEASE / 2) == []
    later = _T0 + CLAIM_LEASE + timedelta(seconds=1)
    assert [item.id for item in claim_native(engine, _USER, now=later)] == [notification_id]


def test_confirm_native_ignores_other_users_and_unclaimed_rows(engine, local_mode: None) -> None:
    """Only the caller's claimed rows turn sent."""
    mine = notify(_USER, "finished", "opt-1", title="Ticket triage", now=_T0)
    theirs = notify("someone@else.test", "finished", "opt-2", title="Not mine", now=_T0)
    claim_native(engine, "someone@else.test", now=_T0)

    assert confirm_native(engine, _USER, [mine, theirs], now=_T0) == 0
    assert _macos_state(engine, mine)["state"] == "queued"
    assert _macos_state(engine, theirs)["state"] == "claimed"


def test_claim_native_expires_queued_rows_older_than_a_day(engine, local_mode: None) -> None:
    """A delivery the app could not show within a day is marked expired, not left queued forever."""
    stale = notify(_USER, "finished", "opt-old", title="Old run", now=_T0)
    leased = notify(_USER, "failed", "opt-leased", title="Old leased run", now=_T0)
    claim_native(engine, _USER, now=_T0)
    claim_native(engine, _USER, now=_T0)
    fresh_time = _T0 + timedelta(days=2)
    fresh = notify(_USER, "finished", "opt-new", title="New run", now=fresh_time)

    claimed = claim_native(engine, _USER, now=fresh_time)

    assert [item.id for item in claimed] == [fresh]
    assert _macos_state(engine, stale)["state"] == "expired"
    assert _macos_state(engine, leased)["state"] == "expired"


def test_claim_native_reaches_queued_rows_behind_many_handled_ones(engine, local_mode: None) -> None:
    """The batch limit counts only claimable rows, so handled rows never hide a queued one."""
    handled = [
        notify(_USER, "finished", f"opt-{i}", title="Done", dedupe_key=f"d{i}", now=_T0) for i in range(CLAIM_BATCH + 5)
    ]
    first = claim_native(engine, _USER, now=_T0)
    assert len(first) == CLAIM_BATCH
    rest = claim_native(engine, _USER, now=_T0)
    assert len(rest) == 5
    confirm_native(engine, _USER, handled, now=_T0)
    newest = notify(_USER, "failed", "opt-new", title="New", now=_T0 + timedelta(minutes=1))

    assert [item.id for item in claim_native(engine, _USER, now=_T0 + timedelta(minutes=1))] == [newest]


def test_claim_native_is_empty_in_hosted_mode(engine) -> None:
    """Hosted mode never hands out native notifications."""
    notify(_USER, "finished", "opt-1", title="Ticket triage", now=_T0)
    assert claim_native(engine, _USER, now=_T0) == []
