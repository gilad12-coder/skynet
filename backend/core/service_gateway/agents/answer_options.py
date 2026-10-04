"""Clickable answer options the authoring agents offer under a question."""

from __future__ import annotations

from typing import Any


def normalize_options(raw: Any) -> list[dict[str, str]]:
    """Coerce a model options field into ``[{label, description}]``.

    Tolerant of the model emitting either the structured shape or a bare list
    of answer strings; drops entries without a label and caps the list at four.

    Args:
        raw: The parsed ``options_json`` value (any JSON type).

    Returns:
        Up to four ``{"label", "description"}`` dicts with non-empty labels.
    """
    if not isinstance(raw, list):
        return []
    options: list[dict[str, str]] = []
    for item in raw:
        if isinstance(item, dict):
            label = str(item.get("label", "")).strip()
            description = str(item.get("description", "")).strip()
        else:
            label, description = str(item).strip(), ""
        if label:
            options.append({"label": label, "description": description})
    return options[:4]
