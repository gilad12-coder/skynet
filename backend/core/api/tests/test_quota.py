"""Tests for the per-user job quota enforcement.

Rewrites the previously-skipped suite that targeted the removed
``core.job_quota_overrides`` module.  All assertions now go through
``core.config.settings.get_user_quota``.
"""

from __future__ import annotations

from ...config import Settings


def test_get_user_quota_returns_default_for_unknown_user() -> None:
    """Unknown users fall back to the default per-user job cap."""
    s = Settings(max_jobs_per_user=100)

    assert s.get_user_quota("random_user") == 100


def test_get_user_quota_admin_uses_default_quota() -> None:
    """Admin usernames do not bypass normal quota enforcement."""
    s = Settings(admin_usernames="admin,superuser", max_jobs_per_user=100)

    assert s.get_user_quota("admin") == 100
    assert s.get_user_quota("superuser") == 100


def test_get_user_quota_admin_check_does_not_override_case_insensitively() -> None:
    """Admin casing has no effect on quota resolution."""
    s = Settings(admin_usernames="Admin", max_jobs_per_user=100)

    assert s.get_user_quota("admin") == 100


def test_get_user_quota_override_int_takes_precedence() -> None:
    """An integer override raises the cap above the default."""
    # quota_overrides_json uses alias="QUOTA_OVERRIDES" in Settings
    s = Settings(QUOTA_OVERRIDES='{"power": 500}', max_jobs_per_user=100)

    assert s.get_user_quota("power") == 500


def test_get_user_quota_override_none_means_unlimited() -> None:
    """An override of ``null`` makes that user's quota unlimited."""
    s = Settings(QUOTA_OVERRIDES='{"researcher": null}', max_jobs_per_user=100)

    assert s.get_user_quota("researcher") is None


def test_get_user_quota_override_wins_over_admin_status() -> None:
    """Quota overrides are independent from admin authorization."""
    s = Settings(
        admin_usernames="alice",
        QUOTA_OVERRIDES='{"alice": 50}',
        max_jobs_per_user=100,
    )

    assert s.get_user_quota("alice") == 50


def test_get_user_quota_non_overridden_user_gets_default() -> None:
    """A user not in the override map still receives the default cap."""
    s = Settings(QUOTA_OVERRIDES='{"other": 200}', max_jobs_per_user=100)

    assert s.get_user_quota("someone_else") == 100
