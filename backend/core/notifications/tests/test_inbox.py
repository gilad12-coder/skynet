"""Tests for inbox reads, read state, cursors and product news."""

from __future__ import annotations

from datetime import UTC, date, datetime, timedelta

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import Session
from sqlalchemy.pool import StaticPool

from ...storage.models import Base, NotificationModel
from ..inbox import decode_cursor, list_page, mark_all_read, mark_read, remove, unread_counts
from ..news import NEWS_DIR, NewsEntry, ensure_news, load_news, parse_news

_USER = "alice@example.com"
_T0 = datetime(2026, 10, 9, 12, 0, tzinfo=UTC)


@pytest.fixture
def session():
    """Yield a session over an in-memory notifications table.

    Yields:
        An open session.
    """
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    Base.metadata.create_all(engine, tables=[NotificationModel.__table__])
    with Session(engine) as session:
        yield session


def _add(session: Session, event_type: str, minutes: int, *, user: str = _USER, in_inbox: bool = True) -> str:
    """Store one notification.

    Args:
        session: Open session.
        event_type: Catalog event type.
        minutes: Minutes after ``_T0`` it happened.
        user: Owner.
        in_inbox: Whether it shows in the inbox.

    Returns:
        The row id.
    """
    row = NotificationModel(
        username=user,
        event_type=event_type,
        title="Bot",
        facts={},
        created_at=_T0 + timedelta(minutes=minutes),
        deliveries={},
        in_inbox=in_inbox,
    )
    session.add(row)
    session.commit()
    return row.id


def test_tabs_split_focused_from_everything(session: Session) -> None:
    """Focused holds needs-input, near-budget, failed and finished; Everything holds all."""
    for minutes, event in enumerate(["finished", "new_best", "stuck", "needs_input", "shared", "failed"]):
        _add(session, event, minutes)
    _add(session, "finished", 9, in_inbox=False)
    _add(session, "finished", 9, user="bob@example.com")

    focused, _ = list_page(session, _USER, "focused", None, 50)
    everything, _ = list_page(session, _USER, "everything", None, 50)

    assert [row.event_type for row in focused] == ["failed", "needs_input", "finished"]
    assert len(everything) == 6
    assert unread_counts(session, _USER) == {"focused": 3, "everything": 6}


def test_cursor_pages_walk_older_items_without_overlap(session: Session) -> None:
    """Following ``next_cursor`` visits every item once, newest first."""
    ids = [_add(session, "finished", minutes) for minutes in range(5)]

    seen = []
    cursor = None
    while True:
        rows, cursor = list_page(session, _USER, "everything", cursor, 2)
        seen.extend(row.id for row in rows)
        if cursor is None:
            break

    assert seen == list(reversed(ids))


def test_malformed_cursor_starts_from_the_top(session: Session) -> None:
    """A garbage cursor is ignored rather than failing the request."""
    _add(session, "finished", 0)

    assert decode_cursor("not-a-cursor") is None
    rows, _ = list_page(session, _USER, "everything", "not-a-cursor", 10)
    assert len(rows) == 1


def test_mark_read_is_owner_scoped_and_idempotent(session: Session) -> None:
    """Only the owner can mark an item; marking twice keeps the first time."""
    notification_id = _add(session, "finished", 0)

    assert mark_read(session, "bob@example.com", notification_id) is False
    assert mark_read(session, _USER, notification_id, now=_T0) is True
    assert mark_read(session, _USER, notification_id, now=_T0 + timedelta(hours=1)) is True
    assert session.get(NotificationModel, notification_id).read_at.replace(tzinfo=UTC) == _T0


def test_mark_all_read_is_per_tab(session: Session) -> None:
    """Clearing Focused leaves the Everything-only items unread."""
    _add(session, "finished", 0)
    _add(session, "new_best", 1)

    assert mark_all_read(session, _USER, "focused") == 1
    assert unread_counts(session, _USER) == {"focused": 0, "everything": 1}
    assert mark_all_read(session, _USER, "everything") == 1


def test_parse_news_reads_frontmatter_and_body() -> None:
    """A news file yields its title, date, link and markdown body."""
    entry = parse_news("---\ntitle: Hello\ndate: 2026-10-09\nlink: /x\n---\nBody text.\n", "2026-10-09-hello")

    assert entry == NewsEntry("2026-10-09-hello", "Hello", date(2026, 10, 9), "Body text.", "/x")
    assert parse_news("no frontmatter", "x") is None
    assert parse_news("---\ntitle: Hi\ndate: soon\n---\n", "x") is None


def test_ensure_news_adds_each_entry_once_per_user(session: Session) -> None:
    """Every user gets every entry once, with its own read state."""
    entries = (NewsEntry("2026-10-09-a", "A", date(2026, 10, 9), "Body"),)

    ensure_news(session, _USER, entries)
    ensure_news(session, _USER, entries)
    ensure_news(session, "bob@example.com", entries)

    rows, _ = list_page(session, _USER, "everything", None, 10)
    assert [(row.event_type, row.title) for row in rows] == [("product_news", "A")]
    assert list_page(session, _USER, "focused", None, 10)[0] == []
    assert unread_counts(session, "bob@example.com")["everything"] == 1


def test_removed_news_is_not_re_added(session: Session) -> None:
    """Removing a news item is a per-user dismissal that ``ensure_news`` respects."""
    entries = (NewsEntry("2026-10-09-a", "A", date(2026, 10, 9), "Body"),)
    ensure_news(session, _USER, entries)
    ensure_news(session, "bob@example.com", entries)
    (row,), _ = list_page(session, _USER, "everything", None, 10)

    assert remove(session, _USER, row.id) is True
    ensure_news(session, _USER, entries)

    assert list_page(session, _USER, "everything", None, 10)[0] == []
    assert unread_counts(session, _USER)["everything"] == 0
    assert unread_counts(session, "bob@example.com")["everything"] == 1


def test_repo_news_files_all_parse() -> None:
    """Every shipped news file has valid frontmatter."""
    files = sorted(NEWS_DIR.glob("*.md"))

    assert files
    assert len(load_news()) == len(files)
