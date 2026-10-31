"""Tests that desktop-link tokens (``skyl_``) are scrubbed from untrusted values."""

from __future__ import annotations

from ..credential_safety import (
    REDACTED_CREDENTIAL,
    redact_secret_bytes,
    redact_secret_text,
    redact_secret_value,
    scrub_desktop_link_tokens,
    scrub_model_config,
)

_ACCESS = "skyl_at_" + "A1b2-C3d4_" * 4 + "xyz"
_REFRESH = "skyl_rt_" + "Z9y8_X7w6-" * 4 + "abc"


def test_scrub_replaces_both_token_kinds() -> None:
    """Access and refresh tokens are replaced, and the text around them stays."""
    text = f"Authorization: Bearer {_ACCESS}; body={{'refresh_token': '{_REFRESH}'}}"

    out = scrub_desktop_link_tokens(text)

    assert "skyl_" not in out
    assert out.startswith(f"Authorization: Bearer {REDACTED_CREDENTIAL};")


def test_scrub_leaves_other_text() -> None:
    """Words that only start like the prefix stay as they are."""
    assert scrub_desktop_link_tokens("skyl_ and skyline") == "skyl_ and skyline"


def test_redact_helpers_scrub_the_prefix_without_a_fragment() -> None:
    """Untrusted responses lose ``skyl_`` tokens even when the caller passed no fragment."""
    assert "skyl_" not in redact_secret_text(f"echo {_ACCESS}", ())
    assert b"skyl_" not in redact_secret_bytes(f"echo {_REFRESH}".encode(), ())
    assert "skyl_" not in str(redact_secret_value({"a": [f"x {_ACCESS}"]}, ()))


def test_model_config_strings_lose_the_token() -> None:
    """A token pasted into a free-text model option does not reach the guest."""
    config = {"model": "openrouter/x", "extra_body": {"note": f"use {_ACCESS}"}}

    assert "skyl_" not in str(scrub_model_config(config))
