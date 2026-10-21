"""Tests for the local hosted-link client against a fake of the hosted routes."""

from __future__ import annotations

import logging
from datetime import UTC, datetime, timedelta
from urllib.parse import parse_qs, urlsplit

import pytest
from cryptography.fernet import Fernet
from pydantic import SecretStr
from sqlalchemy import create_engine
from sqlalchemy.engine import Engine
from sqlalchemy.pool import StaticPool

from ...api.errors import DomainError
from ...config import settings
from ...connectors.vault import ConnectorVault
from ...storage.models import UserConnectorModel
from .. import hosted_link
from .fake_hosted import API_ORIGIN, APP_ORIGIN, FakeHosted

_USER = "local@skynet.local"


@pytest.fixture
def hosted(monkeypatch: pytest.MonkeyPatch) -> FakeHosted:
    """Point the link client at a fresh fake hosted server in local mode.

    Args:
        monkeypatch: Pytest fixture used to change settings and the transport.

    Returns:
        The fake server.
    """
    fake = FakeHosted()
    monkeypatch.setattr(settings, "local_mode", True)
    monkeypatch.setattr(settings, "api_host", "127.0.0.1")
    monkeypatch.setattr(settings, "port", 8110)
    monkeypatch.setattr(settings, "hosted_app_url", APP_ORIGIN)
    monkeypatch.setattr(settings, "hosted_api_url", API_ORIGIN)
    monkeypatch.setattr(settings, "byok_vault_key", SecretStr(Fernet.generate_key().decode()))
    monkeypatch.setattr(hosted_link, "_TRANSPORT", fake.transport())
    hosted_link.clear_used_states()
    return fake


@pytest.fixture
def engine() -> Engine:
    """Return an in-memory database with the connector table.

    Returns:
        The engine.
    """
    eng = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    UserConnectorModel.__table__.create(eng)
    return eng


def _link(engine: Engine, hosted: FakeHosted) -> None:
    """Run the full link flow, as the Mac UI and the browser do.

    Args:
        engine: Local database.
        hosted: The fake hosted server.
    """
    url = hosted_link.start_link(_USER, device_name="Test Mac")
    _redirect, code, state = hosted.authorize(url)
    hosted_link.finish_link(engine, code=code, state=state)


def test_start_builds_a_pkce_authorize_url(hosted: FakeHosted) -> None:
    """The URL opens the hosted consent page with S256 PKCE and the loopback callback.

    Args:
        hosted: The fake hosted server.
    """
    url = hosted_link.start_link(_USER, device_name="Test Mac")

    parts = urlsplit(url)
    query = {k: v[0] for k, v in parse_qs(parts.query).items()}
    assert f"{parts.scheme}://{parts.netloc}{parts.path}" == f"{APP_ORIGIN}/desktop/link"
    assert query["response_type"] == "code"
    assert query["client_id"] == "skynet-desktop"
    assert query["redirect_uri"] == "http://127.0.0.1:8110/local/hosted-link/callback"
    assert query["code_challenge_method"] == "S256"
    assert len(query["code_challenge"]) == 43
    assert query["scope"] == "identity balance:read sync models connectors web"
    assert query["device_name"] == "Test Mac"
    assert "v" not in query
    assert len(query["state"]) > 40


def test_ipv6_loopback_uses_the_bracket_form(hosted: FakeHosted, monkeypatch: pytest.MonkeyPatch) -> None:
    """An API bound on ``::1`` gets the ``[::1]`` callback the hosted rule accepts.

    Args:
        hosted: The fake hosted server.
        monkeypatch: Pytest fixture used to change the bind host.
    """
    monkeypatch.setattr(settings, "api_host", "::1")

    assert hosted_link.callback_uri() == "http://[::1]:8110/local/hosted-link/callback"


def test_link_saves_the_pair_encrypted(engine: Engine, hosted: FakeHosted) -> None:
    """The callback trades the code and keeps the pair only as ciphertext.

    Args:
        engine: Local database.
        hosted: The fake hosted server.
    """
    _link(engine, hosted)

    status = hosted_link.link_status(engine, _USER)
    assert status is not None
    assert status.account_label == "dana@example.test"
    assert status.scopes == hosted.scopes
    secret = ConnectorVault(engine).resolve(_USER, hosted_link.PROVIDER)
    assert secret is not None
    assert secret.access_token in hosted.access
    assert secret.refresh_token in hosted.refresh
    assert secret.auth_method == "desktop_link"
    with engine.connect() as conn:
        raw = conn.exec_driver_sql("SELECT secret_ciphertext, refresh_ciphertext FROM user_connectors").one()
    assert secret.access_token.encode() not in raw[0]
    assert secret.refresh_token.encode() not in raw[1]


def test_state_is_single_use(engine: Engine, hosted: FakeHosted) -> None:
    """A replayed callback is refused before any call to hosted.

    Args:
        engine: Local database.
        hosted: The fake hosted server.
    """
    url = hosted_link.start_link(_USER, device_name="Test Mac")
    _redirect, code, state = hosted.authorize(url)
    hosted_link.finish_link(engine, code=code, state=state)
    calls = len(hosted.calls)

    with pytest.raises(DomainError) as exc:
        hosted_link.finish_link(engine, code=code, state=state)

    assert exc.value.code == "hosted_link.state_invalid"
    assert len(hosted.calls) == calls


def test_forged_state_is_refused(engine: Engine, hosted: FakeHosted) -> None:
    """A state that the local vault did not encrypt fails.

    Args:
        engine: Local database.
        hosted: The fake hosted server.
    """
    with pytest.raises(DomainError) as exc:
        hosted_link.finish_link(engine, code="abc", state="not-a-state")

    assert exc.value.code == "hosted_link.state_invalid"
    assert hosted.calls == []


def test_expired_state_is_refused(engine: Engine, hosted: FakeHosted, monkeypatch: pytest.MonkeyPatch) -> None:
    """A state older than 600 seconds fails.

    Args:
        engine: Local database.
        hosted: The fake hosted server.
        monkeypatch: Pytest fixture used to shorten the TTL.
    """
    url = hosted_link.start_link(_USER, device_name="Test Mac")
    _redirect, code, state = hosted.authorize(url)
    monkeypatch.setattr(hosted_link, "STATE_TTL_SECONDS", -1)

    with pytest.raises(DomainError) as exc:
        hosted_link.finish_link(engine, code=code, state=state)

    assert exc.value.code == "hosted_link.state_invalid"


def test_code_from_another_flow_fails_the_verifier(engine: Engine, hosted: FakeHosted) -> None:
    """An injected code from another PKCE flow fails at hosted, and nothing is saved.

    Args:
        engine: Local database.
        hosted: The fake hosted server.
    """
    _redirect, attacker_code, _state = hosted.authorize(hosted_link.start_link(_USER, device_name="x"))
    victim_url = hosted_link.start_link(_USER, device_name="Test Mac")
    _redirect, _code, victim_state = hosted.authorize(victim_url)

    with pytest.raises(DomainError) as exc:
        hosted_link.finish_link(engine, code=attacker_code, state=victim_state)

    assert exc.value.code == "hosted_link.failed"
    assert hosted_link.link_status(engine, _USER) is None


def test_start_needs_a_hosted_api_url(hosted: FakeHosted, monkeypatch: pytest.MonkeyPatch) -> None:
    """A build with no hosted API URL refuses to start a link.

    Args:
        hosted: The fake hosted server.
        monkeypatch: Pytest fixture used to clear the URL.
    """
    monkeypatch.setattr(settings, "hosted_api_url", "")

    with pytest.raises(DomainError) as exc:
        hosted_link.start_link(_USER, device_name="Test Mac")

    assert exc.value.code == "hosted_link.not_configured"
    assert exc.value.status_code == 503


def test_fresh_token_is_used_without_refresh(engine: Engine, hosted: FakeHosted) -> None:
    """A token with more than 5 minutes left goes out as is.

    Args:
        engine: Local database.
        hosted: The fake hosted server.
    """
    _link(engine, hosted)

    assert hosted_link.hosted_get(engine, _USER, "/desktop/v1/balance")["available_cents"] == 1234
    assert hosted.refresh_count == 0


def test_token_near_expiry_is_refreshed_and_rotated(engine: Engine, hosted: FakeHosted) -> None:
    """Less than 5 minutes left: the client refreshes and saves the new pair.

    Args:
        engine: Local database.
        hosted: The fake hosted server.
    """
    hosted.access_ttl = 120
    _link(engine, hosted)
    old = ConnectorVault(engine).resolve(_USER, hosted_link.PROVIDER)
    assert old is not None

    token = hosted_link.access_token(engine, _USER)

    new = ConnectorVault(engine).resolve(_USER, hosted_link.PROVIDER)
    assert new is not None
    assert hosted.refresh_count == 1
    assert token == new.access_token != old.access_token
    assert new.refresh_token != old.refresh_token
    assert old.refresh_token not in hosted.refresh


def test_token_expired_answer_refreshes_once(engine: Engine, hosted: FakeHosted) -> None:
    """A 401 ``desktop.token_expired`` makes one refresh and one retry.

    Args:
        engine: Local database.
        hosted: The fake hosted server.
    """
    _link(engine, hosted)
    secret = ConnectorVault(engine).resolve(_USER, hosted_link.PROVIDER)
    assert secret is not None
    hosted.expired_access.add(secret.access_token)

    who = hosted_link.hosted_get(engine, _USER, "/desktop/v1/whoami")

    assert who["email"] == "dana@example.test"
    assert hosted.refresh_count == 1


def test_parallel_refresh_runs_once(engine: Engine, hosted: FakeHosted) -> None:
    """A second caller that waited on the lock reads the new pair, not a second refresh.

    Args:
        engine: Local database.
        hosted: The fake hosted server.
    """
    hosted.access_ttl = 120
    _link(engine, hosted)
    stale = ConnectorVault(engine).resolve(_USER, hosted_link.PROVIDER)
    assert stale is not None
    first = hosted_link.access_token(engine, _USER)
    hosted.access_ttl = 3600

    second = hosted_link.refresh_after(engine, _USER, stale_access_token=stale.access_token)

    assert second == first
    assert hosted.refresh_count == 1


def test_revoked_link_clears_local_data(engine: Engine, hosted: FakeHosted) -> None:
    """When hosted says the link is revoked, the Mac deletes its link data.

    Args:
        engine: Local database.
        hosted: The fake hosted server.
    """
    _link(engine, hosted)
    vault = ConnectorVault(engine)
    vault.save(_USER, "google_drive", access_token="ya29.fake", auth_method="oauth_relay", account_label="d")
    vault.save(_USER, "notion", access_token="secret_fake", auth_method="token", account_label="n")
    hosted.revoked = True

    with pytest.raises(DomainError) as exc:
        hosted_link.hosted_get(engine, _USER, "/desktop/v1/whoami")

    assert exc.value.code == "hosted_link.revoked"
    assert exc.value.status_code == 401
    assert hosted_link.link_status(engine, _USER) is None
    assert vault.get(_USER, "google_drive") is None
    assert vault.get(_USER, "notion") is not None


def test_offline_is_a_clear_error(engine: Engine, hosted: FakeHosted) -> None:
    """No network: 503 ``hosted_link.unreachable``, and the link stays.

    Args:
        engine: Local database.
        hosted: The fake hosted server.
    """
    _link(engine, hosted)
    hosted.reachable = False

    with pytest.raises(DomainError) as exc:
        hosted_link.hosted_get(engine, _USER, "/desktop/v1/balance")

    assert exc.value.code == "hosted_link.unreachable"
    assert exc.value.status_code == 503
    assert hosted_link.link_status(engine, _USER) is not None


def test_not_linked_is_a_clear_error(engine: Engine, hosted: FakeHosted) -> None:
    """Calls before a link fail with 409 ``hosted_link.not_linked``.

    Args:
        engine: Local database.
        hosted: The fake hosted server.
    """
    with pytest.raises(DomainError) as exc:
        hosted_link.access_token(engine, _USER)

    assert exc.value.code == "hosted_link.not_linked"
    assert exc.value.status_code == 409


def test_unlink_revokes_and_deletes(engine: Engine, hosted: FakeHosted) -> None:
    """Unlink sends the refresh token to revoke, then deletes the local link.

    Args:
        engine: Local database.
        hosted: The fake hosted server.
    """
    _link(engine, hosted)
    secret = ConnectorVault(engine).resolve(_USER, hosted_link.PROVIDER)
    assert secret is not None

    assert hosted_link.unlink(engine, _USER) is True

    assert hosted.revoke_bodies == [{"token": secret.refresh_token}]
    assert hosted_link.link_status(engine, _USER) is None


def test_unlink_offline_still_deletes_local_data(engine: Engine, hosted: FakeHosted) -> None:
    """Offline unlink deletes the local data and reports that hosted was not told.

    Args:
        engine: Local database.
        hosted: The fake hosted server.
    """
    _link(engine, hosted)
    hosted.reachable = False

    assert hosted_link.unlink(engine, _USER) is False
    assert hosted_link.link_status(engine, _USER) is None


def test_expiry_is_saved(engine: Engine, hosted: FakeHosted) -> None:
    """The saved expiry follows ``expires_in``.

    Args:
        engine: Local database.
        hosted: The fake hosted server.
    """
    before = datetime.now(UTC)
    _link(engine, hosted)

    secret = ConnectorVault(engine).resolve(_USER, hosted_link.PROVIDER)
    assert secret is not None
    assert secret.expires_at is not None
    assert before + timedelta(seconds=3590) < secret.expires_at < before + timedelta(seconds=3610)


def test_tokens_never_reach_the_logs(engine: Engine, hosted: FakeHosted, caplog: pytest.LogCaptureFixture) -> None:
    """The full flow, a refresh, a revoke and an error log no token.

    Args:
        engine: Local database.
        hosted: The fake hosted server.
        caplog: Pytest fixture that captures log records.
    """
    caplog.set_level(logging.DEBUG)
    hosted.access_ttl = 120
    _link(engine, hosted)
    hosted_link.access_token(engine, _USER)
    hosted.reachable = False
    with pytest.raises(DomainError):
        hosted_link.hosted_get(engine, _USER, "/desktop/v1/balance")
    hosted.reachable = True
    hosted_link.unlink(engine, _USER)

    assert "skyl_" not in caplog.text
    for token in hosted.access | hosted.refresh:
        assert token not in caplog.text
