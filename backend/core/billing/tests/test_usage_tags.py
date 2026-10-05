"""Usage tags stay small, known and safe however they arrive."""

from __future__ import annotations

from core.billing.usage_tags import (
    USAGE_TAGS_HEADER,
    current_tags,
    header_tags,
    parse_tags,
    usage_scope,
    usage_tags_token,
    with_tags_header,
)


def test_parse_keeps_only_known_short_values() -> None:
    """Drop unknown keys, control characters and oversized values."""
    raw = '{"stage":"training","role":"judge","candidate":"7","case":"bad\\nvalue","pair":"' + "x" * 80 + '"}'
    assert parse_tags(raw) == {"stage": "training", "candidate": "7", "pair": "x" * 64}


def test_parse_ignores_malformed_headers() -> None:
    """Treat broken JSON, non-objects and oversized headers as untagged."""
    assert parse_tags("not json") == {}
    assert parse_tags("[1]") == {}
    assert parse_tags("{" + " " * 600 + "}") == {}
    assert parse_tags(None) == {}


def test_scopes_nest_and_restore() -> None:
    """Inner scopes override what they set and restore the outer tags on exit."""
    with usage_scope(candidate="1", case="a"):
        with usage_scope(case="b", stage=None):
            assert current_tags() == {"candidate": "1", "case": "b"}
        assert current_tags() == {"candidate": "1", "case": "a"}
    assert current_tags() == {}


def test_token_reset_restores_outer_tags() -> None:
    """A callback-opened scope closes back to the outer tags."""
    with usage_scope(stage="baseline"):
        token = usage_tags_token(pair=2)
        assert current_tags() == {"stage": "baseline", "pair": "2"}
        token.reset()
        assert current_tags() == {"stage": "baseline"}


def test_trusted_tags_override_guest_header() -> None:
    """Host tags win over the same keys a guest sent, and guest-only keys survive."""
    headers = with_tags_header(
        {"Authorization": "Bearer x", "X-Skynet-Usage-Tags": '{"candidate":"9","case":"c1"}'}, {"candidate": "2"}
    )
    assert headers["Authorization"] == "Bearer x"
    assert header_tags(headers) == {"candidate": "2", "case": "c1"}
    assert list(headers).count(USAGE_TAGS_HEADER) == 1
    assert "X-Skynet-Usage-Tags" not in headers
