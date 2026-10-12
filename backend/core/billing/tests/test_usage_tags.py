"""Usage tags stay small, known and safe however they arrive."""

from __future__ import annotations

import threading
from concurrent.futures import ThreadPoolExecutor

from core.billing.usage_tags import (
    TAG_KEYS,
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


def test_lane_is_a_known_key() -> None:
    """``lane`` survives cleaning and the header round trip; existing keys are unchanged."""
    assert TAG_KEYS == ("stage", "pair", "candidate", "case", "caller", "kind", "lane")
    assert parse_tags('{"lane":"explore-gepa","stage":"training"}') == {"lane": "explore-gepa", "stage": "training"}
    assert header_tags(with_tags_header(None, {"lane": "continue-gepa"})) == {"lane": "continue-gepa"}


def test_lane_follows_calls_into_child_threads() -> None:
    """Threads and pools started inside a lane keep only its ``lane`` tag."""
    seen: dict[str, dict[str, str]] = {}

    def record(name: str) -> None:
        """Capture the tags a call on this thread would carry.

        Args:
            name: Slot to record under.
        """
        seen[name] = current_tags()

    with usage_scope(lane="explore-gepa", stage="training", candidate="3"):
        thread = threading.Thread(target=record, args=("thread",))
        thread.start()
        thread.join()
        with ThreadPoolExecutor(max_workers=1) as pool:
            pool.submit(record, "pool").result()
    outside = threading.Thread(target=record, args=("outside",))
    outside.start()
    outside.join()

    assert seen["thread"] == {"lane": "explore-gepa"}
    assert seen["pool"] == {"lane": "explore-gepa"}
    assert seen["outside"] == {}


def test_child_thread_scopes_nest_over_the_lane() -> None:
    """A child thread's own scopes add to the inherited lane and restore it on exit."""
    seen: list[dict[str, str]] = []

    def work() -> None:
        """Open a scope on the child thread and record the tags inside and after it."""
        with usage_scope(stage="training", caller="reflection"):
            seen.append(current_tags())
        seen.append(current_tags())

    with usage_scope(lane="continue-gepa"):
        thread = threading.Thread(target=work)
        thread.start()
        thread.join()

    assert seen == [{"lane": "continue-gepa", "stage": "training", "caller": "reflection"}, {"lane": "continue-gepa"}]
