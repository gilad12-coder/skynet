"""The size gate on an agent chat's automatic opening turn.

An agent chat opens by itself once the user hands it something to look at: a
repository, a dataset, sample cases. Whether that opening reads the input
with the model or posts a fixed message is decided here, by the input's size
against one budget, never by the model. An input over the budget gets the
fixed opening: no model call, no charge, no turn against a usage cap. The
client renders it in the user's language from the event's ``subject``.
"""

from __future__ import annotations

import json
from collections.abc import AsyncIterator
from typing import Any, Literal

# About 16k tokens: room for a README, a manifest and a mid-sized repository's
# file list, or a handful of long sample rows, with the prompt still small.
KICKOFF_CONTEXT_BUDGET_BYTES = 64_000

KICKOFF_OVERSIZED_EVENT = "kickoff_oversized"

KickoffSubject = Literal["repo", "data"]


def measured_bytes(*parts: Any) -> int:
    """Measure what an opening turn would load, in UTF-8 bytes.

    Args:
        *parts: Strings count as they are; anything else counts as its JSON.

    Returns:
        The total byte size of every part.
    """
    total = 0
    for part in parts:
        text = part if isinstance(part, str) else json.dumps(part, ensure_ascii=False, default=str)
        total += len(text.encode("utf-8"))
    return total


def fits_kickoff_budget(size_bytes: int) -> bool:
    """Tell whether an opening turn may load an input of this size.

    Args:
        size_bytes: The input's measured size.

    Returns:
        ``True`` when it is within ``KICKOFF_CONTEXT_BUDGET_BYTES``.
    """
    return size_bytes <= KICKOFF_CONTEXT_BUDGET_BYTES


async def oversized_kickoff(subject: KickoffSubject, name: str = "") -> AsyncIterator[dict]:
    """Stream the fixed opening for an input too large to load.

    Args:
        subject: What the user handed over, which picks the client's message.
        name: The input's display name (a repository's ``owner/name``), if any.

    Yields:
        The single ``kickoff_oversized`` event.
    """
    yield {"event": KICKOFF_OVERSIZED_EVENT, "data": {"subject": subject, "name": name}}
