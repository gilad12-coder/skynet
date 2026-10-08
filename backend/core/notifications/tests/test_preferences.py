"""Tests for the database-backed notification preference resolver."""

from __future__ import annotations

from sqlalchemy import create_engine
from sqlalchemy.orm import Session
from sqlalchemy.pool import StaticPool

from ...storage.models import NotificationPreferenceModel
from ..preferences import (
    RunNotificationSettings,
    configure_notification_preferences,
    notification_category_enabled,
    run_notification_settings,
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


def test_missing_preference_row_defaults_both_categories_on() -> None:
    """An identity without overrides keeps historical delivery behavior."""
    engine = _engine()
    configure_notification_preferences(engine)

    assert notification_category_enabled("new@example.com", "job_updates") is True
    assert notification_category_enabled("new@example.com", "sharing_updates") is True


def test_stored_preference_disables_only_selected_category() -> None:
    """Category checks honor independent job and sharing switches."""
    engine = _engine()
    with Session(engine) as session:
        session.add(
            NotificationPreferenceModel(
                username="alice@example.com",
                job_updates_enabled=False,
                sharing_updates_enabled=True,
            )
        )
        session.commit()
    configure_notification_preferences(engine)

    assert notification_category_enabled("alice@example.com", "job_updates") is False
    assert notification_category_enabled("alice@example.com", "sharing_updates") is True


def test_run_settings_default_to_done_cadence_without_a_row() -> None:
    """A missing row yields the defaults, which send no in-run mail."""
    configure_notification_preferences(_engine())

    settings = run_notification_settings("new@example.com")

    assert settings == RunNotificationSettings()
    assert settings is not None
    assert settings.milestones is False
    assert settings.live is False


def test_run_settings_read_the_stored_cadence() -> None:
    """Stored cadence fields flow into the effective settings."""
    engine = _engine()
    with Session(engine) as session:
        session.add(
            NotificationPreferenceModel(
                username="bob@example.com",
                cadence="live",
                live_mode="digest",
                digest_minutes=30,
            )
        )
        session.commit()
    configure_notification_preferences(engine)

    settings = run_notification_settings("bob@example.com")

    assert settings is not None
    assert (settings.cadence, settings.live_mode, settings.digest_minutes) == ("live", "digest", 30)
    assert settings.milestones is True
    assert settings.live is True
    assert settings.live_count == 3


def test_run_settings_are_off_when_job_mail_is_disabled() -> None:
    """``job_updates_enabled=false`` is the master switch for every run email."""
    engine = _engine()
    with Session(engine) as session:
        session.add(
            NotificationPreferenceModel(username="carol@example.com", job_updates_enabled=False, cadence="live")
        )
        session.commit()
    configure_notification_preferences(engine)

    assert run_notification_settings("carol@example.com") is None
