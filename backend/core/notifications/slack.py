"""The Skynet Slack app: OAuth install, Web API calls and the message layout.

Each user installs the app into their own workspace ("Add to Slack"). The
install's bot token is Fernet-encrypted with the connector vault key and kept
in :class:`core.storage.models.SlackConnectionModel`; the Slack notification
channel posts with it to a DM with the installing user or to a channel the
user picked. Only :mod:`httpx` is used, against ``https://slack.com/api``.
"""

from __future__ import annotations

import contextlib
import json
import secrets
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any
from urllib.parse import urlencode

import httpx
from cryptography.fernet import InvalidToken

from ..api.errors import DomainError
from ..config import settings
from ..connectors.vault import vault_cipher
from ..i18n import t_locale
from ..storage.models import SlackConnectionModel
from .email_render import EVENT_TYPES as EMAIL_EVENT_TYPES
from .email_render import absolute_url, build_facts, event_fact_keys

SLACK_API_URL = "https://slack.com/api"
AUTHORIZE_URL = "https://slack.com/oauth/v2/authorize"
BOT_SCOPES: tuple[str, ...] = ("chat:write", "im:write", "channels:read", "groups:read")
STATE_TTL_SECONDS = 600
API_TIMEOUT = httpx.Timeout(15.0)
CHANNEL_PAGE_SIZE = 200
# A workspace with more channels than this is paged no further; the picker says so.
MAX_CHANNELS = 1000

STATUS_CONNECTED = "connected"
STATUS_BROKEN = "broken"

# The install is gone or unusable; only a reconnect fixes these.
TOKEN_ERRORS: frozenset[str] = frozenset(
    {"token_revoked", "account_inactive", "invalid_auth", "not_authed", "token_expired", "team_disabled"}
)
# The chosen destination can't take posts; picking another one (or inviting the bot) fixes these.
TARGET_ERRORS: frozenset[str] = frozenset({"channel_not_found", "not_in_channel", "is_archived"})
BROKEN_ERRORS: frozenset[str] = TOKEN_ERRORS | TARGET_ERRORS

_STATE_PROVIDER = "slack"
_BIDI_ISOLATES = dict.fromkeys(range(0x2066, 0x206A))
_SECTION_TEXT_MAX = 2900
_BUTTON_TEXT_MAX = 75
# Tests swap in an ``httpx.MockTransport``; ``None`` is the real network.
_TRANSPORT: httpx.BaseTransport | None = None


class SlackApiError(Exception):
    """Slack answered ``ok: false`` (or rate-limited the call)."""

    def __init__(self, code: str) -> None:
        """Keep Slack's error code.

        Args:
            code: Slack's ``error`` field, e.g. ``not_in_channel``.
        """
        super().__init__(code)
        self.code = code


class SlackUnreachableError(Exception):
    """Slack could not be reached or answered with a server error."""


@dataclass(frozen=True)
class SlackInstall:
    """What ``oauth.v2.access`` returns for a bot install."""

    team_id: str
    team_name: str
    bot_user_id: str
    slack_user_id: str
    access_token: str


@dataclass(frozen=True)
class SlackChannelInfo:
    """One channel the bot can see."""

    id: str
    name: str
    is_private: bool
    is_member: bool


def slack_configured() -> bool:
    """Report whether this server can offer the Slack channel at all.

    Returns:
        ``True`` when the app's client id and secret and the vault key are set.
    """
    return (
        bool(settings.slack_client_id)
        and settings.slack_client_secret is not None
        and (settings.byok_vault_key is not None)
    )


def _require_configured() -> tuple[str, str]:
    """Return the app's client id and secret, or refuse.

    Returns:
        ``(client_id, client_secret)``.

    Raises:
        DomainError: 503 when the Slack app is not configured.
    """
    if not slack_configured() or settings.slack_client_secret is None or not settings.slack_client_id:
        raise DomainError("notifications.slack_not_configured", status=503)
    return settings.slack_client_id, settings.slack_client_secret.get_secret_value()


def build_authorize_url(username: str, redirect_uri: str) -> str:
    """Mint the "Add to Slack" URL for ``username``.

    The ``state`` is Fernet-encrypted (so it is authenticated and carries its
    own timestamp) and names the user who started the flow, the redirect URI
    and a nonce; the callback only accepts it for :data:`STATE_TTL_SECONDS`.

    Args:
        username: The signed-in user connecting Slack.
        redirect_uri: The callback URL registered on the Slack app.

    Returns:
        The Slack authorize URL to send the browser to.

    Raises:
        DomainError: 503 when the Slack app is not configured.
    """
    client_id, _ = _require_configured()
    payload = {"p": _STATE_PROVIDER, "u": username, "r": redirect_uri, "n": secrets.token_urlsafe(16)}
    state = vault_cipher().encrypt(json.dumps(payload).encode("utf-8")).decode("ascii")
    params = {
        "client_id": client_id,
        "scope": ",".join(BOT_SCOPES),
        "redirect_uri": redirect_uri,
        "state": state,
    }
    return f"{AUTHORIZE_URL}?{urlencode(params)}"


def parse_state(state: str) -> dict[str, str]:
    """Decrypt and validate the ``state`` Slack echoed back.

    Args:
        state: The opaque state parameter.

    Returns:
        The payload: ``u`` (username) and ``r`` (redirect URI).

    Raises:
        DomainError: 400 when the state is forged, tampered with, minted for
            another provider or older than :data:`STATE_TTL_SECONDS`; 503 when
            the vault key is unset.
    """
    try:
        payload = json.loads(vault_cipher().decrypt(state.encode("ascii"), ttl=STATE_TTL_SECONDS))
    except (InvalidToken, ValueError, UnicodeEncodeError) as exc:
        raise DomainError("notifications.slack_state_invalid", status=400) from exc
    if (
        not isinstance(payload, dict)
        or payload.get("p") != _STATE_PROVIDER
        or not all(isinstance(payload.get(key), str) and payload[key] for key in ("u", "r"))
    ):
        raise DomainError("notifications.slack_state_invalid", status=400)
    return payload


def encrypt_token(token: str) -> str:
    """Encrypt a bot token for storage.

    Args:
        token: The plaintext ``xoxb-`` token.

    Returns:
        The Fernet token as text.
    """
    return vault_cipher().encrypt(token.encode("utf-8")).decode("ascii")


def decrypt_token(stored: str) -> str:
    """Decrypt a stored bot token.

    Args:
        stored: Output of :func:`encrypt_token`.

    Returns:
        The plaintext token.

    Raises:
        InvalidToken: When the vault key changed since the token was stored.
    """
    return vault_cipher().decrypt(stored.encode("ascii")).decode("utf-8")


def _client() -> httpx.Client:
    """Return a client for one Slack exchange.

    Returns:
        An ``httpx.Client`` on the real network, or on the test transport.
    """
    return httpx.Client(transport=_TRANSPORT, timeout=API_TIMEOUT)


def _answer(response: httpx.Response) -> dict[str, Any]:
    """Unwrap a Web API response.

    Args:
        response: Slack's HTTP response.

    Returns:
        The JSON body of a successful call.

    Raises:
        SlackApiError: ``ok: false``, or ``ratelimited`` on HTTP 429.
        SlackUnreachableError: A server error or a body that is not JSON.
    """
    if response.status_code == 429:
        raise SlackApiError("ratelimited")
    if response.status_code >= 500:
        raise SlackUnreachableError(f"HTTP {response.status_code}")
    try:
        body = response.json()
    except ValueError as exc:
        raise SlackUnreachableError("non-JSON answer") from exc
    if not isinstance(body, dict) or not body.get("ok"):
        error = body.get("error") if isinstance(body, dict) else None
        raise SlackApiError(str(error or "unknown_error"))
    return body


def call(
    method: str, token: str, *, payload: Mapping[str, Any] | None = None, params: Mapping[str, Any] | None = None
) -> dict[str, Any]:
    """Call one Web API method with a bot token.

    Args:
        method: Method name, e.g. ``chat.postMessage``.
        token: The bot token.
        payload: JSON body; the call is a POST.
        params: Query parameters; the call is a GET (read methods).

    Returns:
        Slack's JSON answer.

    Raises:
        SlackApiError: Slack refused the call.
        SlackUnreachableError: The network or Slack failed.
    """
    url = f"{SLACK_API_URL}/{method}"
    headers = {"Authorization": f"Bearer {token}"}
    try:
        with _client() as client:
            if params is not None:
                response = client.get(url, params=dict(params), headers=headers)
            else:
                response = client.post(url, json=dict(payload or {}), headers=headers)
    except httpx.HTTPError as exc:
        raise SlackUnreachableError(str(exc)) from exc
    return _answer(response)


def exchange_code(code: str, redirect_uri: str) -> SlackInstall:
    """Trade the callback's code for the bot install (``oauth.v2.access``).

    Args:
        code: The authorization code.
        redirect_uri: The redirect URI the code was issued for.

    Returns:
        The install.

    Raises:
        DomainError: 503 when not configured.
        SlackApiError: Slack refused the code, or the answer lacks a bot token.
        SlackUnreachableError: The network or Slack failed.
    """
    client_id, client_secret = _require_configured()
    try:
        with _client() as client:
            response = client.post(
                f"{SLACK_API_URL}/oauth.v2.access",
                data={"code": code, "redirect_uri": redirect_uri},
                auth=(client_id, client_secret),
            )
    except httpx.HTTPError as exc:
        raise SlackUnreachableError(str(exc)) from exc
    body = _answer(response)
    team = body.get("team") or {}
    authed_user = body.get("authed_user") or {}
    fields = {
        "team_id": team.get("id"),
        "team_name": team.get("name"),
        "bot_user_id": body.get("bot_user_id"),
        "slack_user_id": authed_user.get("id"),
        "access_token": body.get("access_token"),
    }
    if body.get("token_type") != "bot" or not all(isinstance(value, str) and value for value in fields.values()):
        raise SlackApiError("unexpected_install")
    return SlackInstall(**fields)


def revoke(token: str) -> None:
    """Revoke a bot token, ignoring every failure (the row goes either way).

    Args:
        token: The bot token.
    """
    with contextlib.suppress(SlackApiError, SlackUnreachableError):
        call("auth.revoke", token)


def list_channels(token: str) -> tuple[list[SlackChannelInfo], bool]:
    """List the public channels and the private channels the bot is in.

    Args:
        token: The bot token.

    Returns:
        ``(channels sorted by name, truncated)``; ``truncated`` is ``True`` when
        the workspace has more than :data:`MAX_CHANNELS`.

    Raises:
        SlackApiError: Slack refused the call.
        SlackUnreachableError: The network or Slack failed.
    """
    channels: list[SlackChannelInfo] = []
    cursor = ""
    while True:
        params = {
            "types": "public_channel,private_channel",
            "exclude_archived": "true",
            "limit": CHANNEL_PAGE_SIZE,
        }
        if cursor:
            params["cursor"] = cursor
        body = call("conversations.list", token, params=params)
        channels.extend(_channel(raw) for raw in body.get("channels") or [] if isinstance(raw, dict))
        cursor = str((body.get("response_metadata") or {}).get("next_cursor") or "")
        if not cursor:
            truncated = False
            break
        if len(channels) >= MAX_CHANNELS:
            truncated = True
            break
    channels.sort(key=lambda channel: channel.name.casefold())
    return channels[:MAX_CHANNELS], truncated


def _channel(raw: Mapping[str, Any]) -> SlackChannelInfo:
    """Read one channel object.

    Args:
        raw: A conversation object from the Web API.

    Returns:
        The channel.
    """
    return SlackChannelInfo(
        id=str(raw.get("id") or ""),
        name=str(raw.get("name") or ""),
        is_private=bool(raw.get("is_private")),
        is_member=bool(raw.get("is_member")),
    )


def channel_info(token: str, channel_id: str) -> SlackChannelInfo:
    """Look up one channel (``conversations.info``).

    Args:
        token: The bot token.
        channel_id: The channel.

    Returns:
        The channel.

    Raises:
        SlackApiError: ``channel_not_found`` when the bot can't see it.
        SlackUnreachableError: The network or Slack failed.
    """
    body = call("conversations.info", token, params={"channel": channel_id})
    raw = body.get("channel")
    if not isinstance(raw, dict):
        raise SlackApiError("channel_not_found")
    if raw.get("is_archived"):
        raise SlackApiError("is_archived")
    return _channel(raw)


def open_dm(token: str, slack_user_id: str) -> str:
    """Open (or find) the bot's DM with a user.

    Args:
        token: The bot token.
        slack_user_id: The Slack user.

    Returns:
        The DM channel id.

    Raises:
        SlackApiError: Slack refused the call.
        SlackUnreachableError: The network or Slack failed.
    """
    body = call("conversations.open", token, payload={"users": slack_user_id})
    channel_id = (body.get("channel") or {}).get("id")
    if not isinstance(channel_id, str) or not channel_id:
        raise SlackApiError("channel_not_found")
    return channel_id


def post_message(token: str, channel_id: str, text: str, blocks: Sequence[Mapping[str, Any]]) -> None:
    """Post one message (``chat.postMessage``).

    Args:
        token: The bot token.
        channel_id: Destination channel or DM.
        text: Notification fallback text.
        blocks: Block Kit layout.

    Raises:
        SlackApiError: Slack refused the post.
        SlackUnreachableError: The network or Slack failed.
    """
    call(
        "chat.postMessage",
        token,
        payload={"channel": channel_id, "text": text, "blocks": list(blocks), "unfurl_links": False},
    )


def mark_broken(row: SlackConnectionModel, reason: str) -> None:
    """Stop sending on a connection until the user fixes it.

    Args:
        row: The connection (the caller commits).
        reason: The Slack error code that broke it.
    """
    row.status = STATUS_BROKEN
    row.broken_reason = reason[:64]
    if reason in TOKEN_ERRORS or (reason == "channel_not_found" and row.channel_id is None):
        row.dm_channel_id = None
    row.updated_at = datetime.now(UTC)


def _escape(text: str) -> str:
    """Escape the three characters Slack mrkdwn treats as markup.

    Args:
        text: Plain text.

    Returns:
        Text safe inside a ``mrkdwn`` field.
    """
    return text.translate(_BIDI_ISOLATES).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def message_blocks(
    event_type: str,
    title: str,
    facts: Mapping[str, Any],
    link: str | None,
    detail: str | None = None,
) -> tuple[str, list[dict[str, Any]]]:
    """Lay out a notification as Block Kit, with the same facts as the email.

    Args:
        event_type: The notification event type.
        title: The run's display name.
        facts: ``score``, ``delta``, ``spent``, ``limit``, ``duration``.
        link: App path or URL the button opens.
        detail: Optional sentence under the headline.

    Returns:
        ``(fallback text, blocks)``: a bold headline, the facts as a context
        line, and a button to the run.
    """
    if event_type in EMAIL_EVENT_TYPES:
        headline = t_locale(None, f"email.event.{event_type}.headline", title=title)
        button: str | None = t_locale(None, f"email.event.{event_type}.button")
        pairs = build_facts(facts, None, event_fact_keys(event_type))
    else:
        headline, button, pairs = title, None, ()
    headline = headline.translate(_BIDI_ISOLATES)
    text = f"*{_escape(headline)}*"
    if detail:
        text += f"\n{_escape(detail)}"
    blocks: list[dict[str, Any]] = [{"type": "section", "text": {"type": "mrkdwn", "text": text[:_SECTION_TEXT_MAX]}}]
    if pairs:
        line = "   ·   ".join(f"{_escape(label)}: *{_escape(value)}*" for label, value in pairs)
        blocks.append({"type": "context", "elements": [{"type": "mrkdwn", "text": line}]})
    if button and link:
        blocks.append(
            {
                "type": "actions",
                "elements": [
                    {
                        "type": "button",
                        "text": {"type": "plain_text", "text": button[:_BUTTON_TEXT_MAX]},
                        "url": absolute_url(link),
                        "style": "primary",
                    }
                ],
            }
        )
    return headline, blocks
