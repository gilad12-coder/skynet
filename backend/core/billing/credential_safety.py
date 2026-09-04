"""Remove credential material from persisted, guest, and response values."""

from __future__ import annotations

import copy
import re
from collections.abc import Iterable
from typing import Any
from urllib.parse import parse_qsl, unquote, urlsplit, urlunsplit

REDACTED_CREDENTIAL = "[REDACTED]"
_SECRET_KEYS = frozenset(
    {
        "access_token",
        "api_key",
        "authorization",
        "authorization_header",
        "client_secret",
        "cookie",
        "credential",
        "credentials",
        "gateway_token",
        "password",
        "private_key",
        "proxy_authorization",
        "refresh_token",
        "secret",
        "set_cookie",
        "_skynet_budget_route",
        "token",
        "x_api_key",
    }
)
_SECRET_CONTAINERS = frozenset({"default_headers", "extra_headers", "headers"})
_ENDPOINT_KEYS = frozenset({"api_base", "base_url", "endpoint", "url"})


def _normalized_key(key: Any) -> str:
    """Normalize mapping keys for case-insensitive credential matching.

    Args:
        key: Arbitrary mapping key.

    Returns:
        Lowercase underscore-separated key text.
    """
    value = re.sub(r"(?<=[a-z0-9])(?=[A-Z])", "_", str(key).strip())
    return value.lower().replace("-", "_")


def _is_secret_key(key: Any) -> bool:
    """Recognize a model option or header that can carry a credential.

    Args:
        key: Arbitrary model-configuration key.

    Returns:
        Whether the key must be removed from untrusted boundaries.
    """
    normalized = _normalized_key(key)
    return normalized in _SECRET_KEYS or normalized.endswith(
        ("_api_key", "_access_token", "_client_secret", "_gateway_token", "_refresh_token")
    )


def public_endpoint(url: str) -> str:
    """Remove user information, query parameters, and fragments from an endpoint URL.

    Args:
        url: Potentially credential-bearing endpoint.

    Returns:
        Endpoint origin and path safe for persistence and display.
    """
    try:
        parsed = urlsplit(url)
    except ValueError:
        return ""
    netloc = parsed.netloc.rsplit("@", 1)[-1]
    return urlunsplit((parsed.scheme, netloc, parsed.path, "", ""))


def endpoint_has_private_components(url: str) -> bool:
    """Check whether an endpoint contains material that must remain in the vault.

    Args:
        url: Owner-selected endpoint.

    Returns:
        Whether user information, a query, or a fragment is present.
    """
    try:
        parsed = urlsplit(url)
    except ValueError:
        return True
    return "@" in parsed.netloc or bool(parsed.query) or bool(parsed.fragment)


def _scrub_model_value(value: Any) -> Any:
    """Recursively strip credentials from one model configuration value.

    Args:
        value: Model configuration fragment.

    Returns:
        Secret-free deep copy.
    """
    if isinstance(value, list):
        return [_scrub_model_value(item) for item in value]
    if not isinstance(value, dict):
        return copy.deepcopy(value)
    cleaned: dict[Any, Any] = {}
    for key, item in value.items():
        normalized = _normalized_key(key)
        if _is_secret_key(key) or normalized in _SECRET_CONTAINERS:
            continue
        if normalized in _ENDPOINT_KEYS and isinstance(item, str):
            cleaned[key] = public_endpoint(item)
        else:
            cleaned[key] = _scrub_model_value(item)
    return cleaned


def scrub_model_config(config: dict[str, Any]) -> dict[str, Any]:
    """Return a model configuration without inline or nested credentials.

    Args:
        config: Public, stored, or parent-resolved model configuration.

    Returns:
        Secret-free deep copy suitable for persistence or a guest.
    """
    return _scrub_model_value(config)


def credential_fragments(secret: str | None, *, endpoint: str | None = None) -> tuple[str, ...]:
    """Collect exact secret strings an untrusted remote response must not echo.

    Args:
        secret: Optional bearer or authorization value.
        endpoint: Optional URL whose private components must remain parent-owned.

    Returns:
        Unique nonempty fragments ordered longest first for safe replacement.
    """
    fragments: set[str] = set()
    if secret:
        value = secret.strip()
        if value:
            fragments.add(value)
            prefix, separator, token = value.partition(" ")
            if separator and prefix.lower() in {"bearer", "basic"} and token:
                fragments.add(token)
    if endpoint:
        try:
            parsed = urlsplit(endpoint)
        except ValueError:
            parsed = None
        if parsed is not None:
            if endpoint_has_private_components(endpoint):
                fragments.add(endpoint)
            if "@" in parsed.netloc:
                userinfo = parsed.netloc.rsplit("@", 1)[0]
                fragments.update(filter(None, (userinfo, unquote(userinfo))))
                fragments.update(filter(None, (parsed.username, parsed.password)))
            fragments.update(value for _key, value in parse_qsl(parsed.query, keep_blank_values=False) if value)
    return tuple(sorted(fragments, key=len, reverse=True))


def redact_secret_text(text: str, fragments: Iterable[str]) -> str:
    """Replace every exact credential fragment in response text.

    Args:
        text: Untrusted response text.
        fragments: Exact parent-owned values to remove.

    Returns:
        Redacted text.
    """
    for fragment in fragments:
        if fragment:
            text = text.replace(fragment, REDACTED_CREDENTIAL)
    return text


def redact_secret_bytes(content: bytes, fragments: Iterable[str]) -> bytes:
    """Replace UTF-8 credential fragments without decoding arbitrary response bytes.

    Args:
        content: Untrusted response body.
        fragments: Exact parent-owned values to remove.

    Returns:
        Redacted response bytes.
    """
    for fragment in fragments:
        if fragment:
            content = content.replace(fragment.encode("utf-8"), REDACTED_CREDENTIAL.encode("utf-8"))
    return content


def redact_secret_value(value: Any, fragments: Iterable[str]) -> Any:
    """Recursively redact credentials from a JSON-compatible response value.

    Args:
        value: Untrusted remote response value.
        fragments: Exact parent-owned values to remove.

    Returns:
        Deep secret-free response copy.
    """
    if isinstance(value, str):
        return redact_secret_text(value, fragments)
    if isinstance(value, list):
        return [redact_secret_value(item, fragments) for item in value]
    if isinstance(value, dict):
        return {key: redact_secret_value(item, fragments) for key, item in value.items()}
    return copy.deepcopy(value)
