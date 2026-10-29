"""Product news: markdown files under ``backend/news`` shown as inbox items.

Each ``YYYY-MM-DD-slug.md`` file has a small frontmatter block (``title``,
``date``, optional ``link``) and a markdown body. Every user sees every entry;
:func:`ensure_news` copies missing entries into the user's inbox lazily, so
read state is per user and needs no fan-out job when a file is added.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import UTC, date, datetime
from functools import lru_cache
from pathlib import Path

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from ..storage.models import NotificationModel
from .catalog import PRODUCT_NEWS

logger = logging.getLogger(__name__)

NEWS_DIR = Path(__file__).resolve().parents[2] / "news"
_DEDUPE_PREFIX = "news:"


@dataclass(frozen=True)
class NewsEntry:
    """One parsed product-news file."""

    slug: str
    title: str
    published: date
    body: str
    link: str | None = None


def parse_news(text: str, slug: str) -> NewsEntry | None:
    """Parse one news file.

    Args:
        text: File contents: ``---`` frontmatter, then the markdown body.
        slug: File stem, used as the entry's stable id.

    Returns:
        The entry, or ``None`` when the frontmatter lacks a title or valid date.
    """
    lines = text.splitlines()
    if not lines or lines[0].strip() != "---":
        return None
    meta: dict[str, str] = {}
    end = None
    for index, line in enumerate(lines[1:], start=1):
        if line.strip() == "---":
            end = index
            break
        key, sep, value = line.partition(":")
        if sep:
            meta[key.strip()] = value.strip().strip('"').strip("'")
    if end is None or not meta.get("title"):
        return None
    try:
        published = date.fromisoformat(meta.get("date", ""))
    except ValueError:
        return None
    return NewsEntry(
        slug=slug,
        title=meta["title"],
        published=published,
        body="\n".join(lines[end + 1 :]).strip(),
        link=meta.get("link") or None,
    )


@lru_cache(maxsize=1)
def load_news(directory: Path = NEWS_DIR) -> tuple[NewsEntry, ...]:
    """Read every news file once per process.

    Args:
        directory: Folder holding the ``.md`` files.

    Returns:
        Entries, oldest first; unreadable or malformed files are skipped.
    """
    entries = []
    for path in sorted(directory.glob("*.md")):
        try:
            entry = parse_news(path.read_text(encoding="utf-8"), path.stem)
        except OSError:
            logger.warning("Unreadable news file %s", path, exc_info=True)
            continue
        if entry is None:
            logger.warning("Skipping news file without title/date frontmatter: %s", path.name)
            continue
        entries.append(entry)
    return tuple(sorted(entries, key=lambda e: (e.published, e.slug)))


def ensure_news(session: Session, username: str, entries: tuple[NewsEntry, ...] | None = None) -> None:
    """Copy news entries the user does not have yet into their inbox.

    Args:
        session: Open session; committed when rows are added.
        username: The inbox owner.
        entries: Entries to ensure; defaults to :func:`load_news`.
    """
    entries = load_news() if entries is None else entries
    if not entries:
        return
    have = set(
        session.scalars(
            select(NotificationModel.dedupe_key).where(
                NotificationModel.username == username,
                NotificationModel.event_type == PRODUCT_NEWS,
            )
        )
    )
    missing = [entry for entry in entries if f"{_DEDUPE_PREFIX}{entry.slug}" not in have]
    if not missing:
        return
    for entry in missing:
        session.add(
            NotificationModel(
                username=username,
                event_type=PRODUCT_NEWS,
                title=entry.title,
                facts={"detail": entry.body},
                link=entry.link,
                dedupe_key=f"{_DEDUPE_PREFIX}{entry.slug}",
                created_at=datetime.combine(entry.published, datetime.min.time(), tzinfo=UTC),
                deliveries={},
            )
        )
    try:
        session.commit()
    except IntegrityError:
        # A concurrent poll for the same user inserted them first.
        session.rollback()
