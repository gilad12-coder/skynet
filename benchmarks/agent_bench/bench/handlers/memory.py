"""Handlers for the agent's OptMem-style memory: notes, naps, recall, zoom.

Memory is a flat list of dated ``notes`` plus a ``summaries`` map keyed by a
``"lo-hi"`` span. The spans form a binary tree: adjacent pairs (#0-1, #2-3, ...)
summarize into quads (#0-3, ...) and so on. A span is *ready* to summarize once
all its notes exist; ``memory_note`` surfaces the next ready-but-unsummarized
span as a compression request, ``memory_nap`` records a span's summary,
``memory_recall`` searches note text, and ``memory_zoom`` opens one span into its
two halves down to the raw notes.
"""

from __future__ import annotations

import re
from typing import Any

from bench.world import ToolError, World, tool


@tool("memory_note", mutates=True)
def memory_note(w: World, args: dict[str, Any]) -> dict[str, Any]:
    """Append a note and report the next span that needs summarizing.

    Args:
        w: The world.
        args: ``text`` for the new note.

    Returns:
        ``{"seq", "note", "total_notes", "compression_request"}``. The request
        (or None) names the oldest ready span with no summary and includes its
        raw notes so the caller can write the summary via :func:`memory_nap`.

    Raises:
        ToolError: 422 when ``text`` is empty.
    """
    text = args.get("text")
    if not text or not str(text).strip():
        raise ToolError(422, "text must not be empty")
    memory = w.s["memory"]
    notes = memory["notes"]
    note = {"seq": len(notes), "date": w.s["now"][:10], "text": text}
    notes.append(note)
    return {
        "seq": note["seq"],
        "note": note,
        "total_notes": len(notes),
        "compression_request": _next_compression(memory),
    }


@tool("memory_nap", mutates=True)
def memory_nap(w: World, args: dict[str, Any]) -> dict[str, Any]:
    """Record a one-line summary for a span of notes.

    Args:
        w: The world.
        args: ``block`` (a ``"lo-hi"`` span) and its ``summary`` line.

    Returns:
        ``{"block", "summary", "stored", "remaining_compressions"}``.

    Raises:
        ToolError: 422 when the block is malformed or the summary is empty, 404
            when the span references notes that do not exist.
    """
    lo, hi = _parse_block(args.get("block"))
    summary = args.get("summary")
    if not summary or not str(summary).strip():
        raise ToolError(422, "summary must not be empty")
    memory = w.s["memory"]
    if hi >= len(memory["notes"]):
        raise ToolError(404, f"span {lo}-{hi} references notes that do not exist yet")
    key = f"{lo}-{hi}"
    memory["summaries"][key] = summary
    return {
        "block": key,
        "summary": summary,
        "stored": True,
        "remaining_compressions": [c["block"] for c in _pending(memory)],
    }


@tool("memory_recall")
def memory_recall(w: World, args: dict[str, Any]) -> dict[str, Any]:
    """Search note text (and summaries) for a regular expression.

    Args:
        w: The world.
        args: ``pattern`` (a case-insensitive regular expression).

    Returns:
        ``{"pattern", "matches", "summary_matches", "total"}`` with the matching
        notes newest-first.

    Raises:
        ToolError: 422 when ``pattern`` is not a valid regular expression.
    """
    pattern = args.get("pattern") or ""
    try:
        rx = re.compile(pattern, re.IGNORECASE)
    except re.error as exc:
        raise ToolError(422, f"invalid recall pattern: {exc}") from exc
    memory = w.s["memory"]
    matches = [dict(n) for n in memory["notes"] if rx.search(n["text"])]
    matches.sort(key=lambda n: n["seq"], reverse=True)
    summary_matches = [{"block": k, "summary": v} for k, v in memory["summaries"].items() if rx.search(v)]
    return {"pattern": pattern, "matches": matches, "summary_matches": summary_matches, "total": len(matches)}


@tool("memory_zoom")
def memory_zoom(w: World, args: dict[str, Any]) -> dict[str, Any]:
    """Open one memory span into its two halves, down to the raw notes.

    Args:
        w: The world.
        args: ``block`` (a ``"lo-hi"`` span, or ``"n-n"`` / ``"n"`` for one note).

    Returns:
        For a single note, ``{"block", "kind": "note", "note": {...}}``. For a
        wider span, ``{"block", "summary", "children": [...]}`` where each child
        is a summary, a raw note, or an unsummarized span.

    Raises:
        ToolError: 422 when the block is malformed, 404 when it references notes
            that do not exist.
    """
    lo, hi = _parse_block(args.get("block"))
    memory = w.s["memory"]
    if hi >= len(memory["notes"]):
        raise ToolError(404, f"span {lo}-{hi} references notes that do not exist")
    if lo == hi:
        return {"block": f"{lo}-{hi}", "kind": "note", "note": dict(memory["notes"][lo])}
    half = (hi - lo + 1) // 2
    halves = [(lo, lo + half - 1), (lo + half, hi)]
    return {
        "block": f"{lo}-{hi}",
        "summary": memory["summaries"].get(f"{lo}-{hi}"),
        "children": [_node(memory, a, b) for a, b in halves],
    }


def _node(memory: dict[str, Any], lo: int, hi: int) -> dict[str, Any]:
    """Describe the span ``lo-hi`` as a raw note, a summary, or an open span."""
    key = f"{lo}-{hi}"
    if lo == hi:
        return {"block": key, "kind": "note", "text": memory["notes"][lo]["text"]}
    if key in memory["summaries"]:
        return {"block": key, "kind": "summary", "summary": memory["summaries"][key]}
    return {"block": key, "kind": "unsummarized", "summary": None}


def _ready_blocks(n_notes: int) -> list[tuple[int, int]]:
    """Return every power-of-two span whose notes all exist, given ``n_notes``.

    Args:
        n_notes: The number of notes (indices ``0..n_notes-1``).

    Returns:
        Spans ``(lo, hi)`` of size 2, 4, 8, ... that are completely filled,
        ordered by size then start.
    """
    blocks = []
    size = 2
    while size <= n_notes:
        blocks.extend((lo, lo + size - 1) for lo in range(0, n_notes - size + 1, size))
        size *= 2
    return blocks


def _pending(memory: dict[str, Any]) -> list[dict[str, Any]]:
    """Return ready spans that have no summary yet, smallest and oldest first."""
    out = []
    for lo, hi in _ready_blocks(len(memory["notes"])):
        if f"{lo}-{hi}" not in memory["summaries"]:
            out.append({"block": f"{lo}-{hi}", "lo": lo, "hi": hi})
    return out


def _next_compression(memory: dict[str, Any]) -> dict[str, Any] | None:
    """Return the next span to summarize with its raw notes, or None."""
    pending = _pending(memory)
    if not pending:
        return None
    nxt = pending[0]
    notes = memory["notes"][nxt["lo"] : nxt["hi"] + 1]
    return {"block": nxt["block"], "notes": [dict(n) for n in notes]}


def _parse_block(block: Any) -> tuple[int, int]:
    """Parse a ``"lo-hi"`` (or ``"n"``) span string into an ordered int pair.

    Raises:
        ToolError: 422 when ``block`` is missing or not a valid span.
    """
    if not block or not isinstance(block, str):
        raise ToolError(422, "block is required (e.g. '0-7' or '3')")
    parts = block.split("-")
    try:
        if len(parts) == 1:
            lo = hi = int(parts[0])
        elif len(parts) == 2:
            lo, hi = int(parts[0]), int(parts[1])
        else:
            raise ValueError
    except ValueError:
        raise ToolError(422, f"malformed block '{block}' (expected 'lo-hi')") from None
    if lo < 0 or hi < lo:
        raise ToolError(422, f"malformed block '{block}' (expected 0 <= lo <= hi)")
    return lo, hi
