"""Tests for the database-backed notification routing resolver."""

from __future__ import annotations

from sqlalchemy import create_engine
from sqlalchemy.orm import Session
from sqlalchemy.pool import StaticPool

from ...storage.models import NotificationPreferenceModel
from ..catalog import DEFAULT_GRID, EMAIL, INBOX, PRODUCT_NEWS
from ..preferences import (
    NotificationSettings,
    clamp_hold_minutes,
    clean_held_channels,
    configure_notification_preferences,
    merge_grid,
    notification_settings,
)


def _engine():
    """Create an in-memory engine containing only the preference table."""
    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    NotificationPreferenceModel.__table__.create(engine)
    return engine


def test_missing_row_yields_the_default_grid() -> None:
    """An identity without a row gets the default grid, a 10 minute hold on email."""
    configure_notification_preferences(_engine())

    settings = notification_settings("new@example.com")

    assert settings == NotificationSettings()
    assert settings.grid == DEFAULT_GRID
    assert settings.hold_minutes == 10
    assert settings.held_channels == (EMAIL,)


def test_stored_cells_overlay_the_defaults() -> None:
    """A partial stored grid changes only its cells."""
    engine = _engine()
    with Session(engine) as session:
        session.add(
            NotificationPreferenceModel(
                username="bob@example.com",
                channel_grid={"finished": {"email": False}, "stuck": {"slack": True}},
                hold_minutes=3,
                held_channels=["slack", "email"],
            )
        )
        session.commit()
    configure_notification_preferences(engine)

    settings = notification_settings("bob@example.com")

    assert settings.enabled("finished", EMAIL) is False
    assert settings.enabled("finished", INBOX) is True
    assert settings.enabled("stuck", "slack") is True
    assert settings.enabled("failed", EMAIL) is True
    assert settings.hold_minutes == 3
    assert settings.held_channels == ("email", "slack")


def test_product_news_is_forced_inbox_only() -> None:
    """No stored grid can route product news outside the inbox."""
    grid = merge_grid({PRODUCT_NEWS: {"email": True, "inbox": False}})

    assert grid[PRODUCT_NEWS] == {"inbox": True, "email": False, "chrome": False, "slack": False}


def test_merge_grid_ignores_unknown_and_malformed_cells() -> None:
    """Unknown events and channels and non-bool values never reach the grid."""
    grid = merge_grid({"mystery": {"email": True}, "failed": {"fax": True, "email": "no"}, "stuck": []})

    assert grid == DEFAULT_GRID


def test_hold_and_held_channel_cleaning() -> None:
    """Hold minutes are clamped; held channels keep only delivery channels."""
    assert clamp_hold_minutes(-5) == 0
    assert clamp_hold_minutes(99999) == 1440
    assert clamp_hold_minutes("7") == 10
    assert clean_held_channels(None) == (EMAIL,)
    assert clean_held_channels(["inbox", "chrome", "fax"]) == ("chrome",)
    assert clean_held_channels([]) == ()


def test_unconfigured_engine_falls_back_to_defaults() -> None:
    """Without storage the settings are the defaults, never an error."""
    assert notification_settings("anyone@example.com") == NotificationSettings()
