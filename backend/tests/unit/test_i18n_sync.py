"""Tests for translation-sync placeholder validation."""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
SPEC = importlib.util.spec_from_file_location("skynet_i18n_sync", ROOT / "scripts/i18n_sync.py")
assert SPEC is not None
assert SPEC.loader is not None
i18n_sync = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = i18n_sync
SPEC.loader.exec_module(i18n_sync)


def test_plural_signature_allows_locale_specific_categories() -> None:
    """Allow translated ICU plurals to add locale-specific selectors."""
    english = "Wait {seconds, plural, one {1 second} other {# seconds}}."
    russian = (
        "Подождите {seconds, plural, one {# секунду} few {# секунды} "
        "many {# секунд} other {# секунды}}."
    )

    assert i18n_sync._placeholder_signature(english) == i18n_sync._placeholder_signature(russian)


def test_plural_signature_requires_other_fallback() -> None:
    """Reject translated ICU plurals without a safe other fallback."""
    source = "Wait {seconds, plural, one {1 second} other {# seconds}}."
    translated = "Attendez {seconds, plural, one {1 seconde}}."

    assert i18n_sync._placeholder_signature(source) != i18n_sync._placeholder_signature(translated)


def test_plural_signature_preserves_variable_names() -> None:
    """Reject translations that rename interpolation variables."""
    source = "Wait {seconds, plural, one {1 second} other {# seconds}}."
    translated = "Wait {duration, plural, one {1 second} other {# seconds}}."

    assert i18n_sync._placeholder_signature(source) != i18n_sync._placeholder_signature(translated)
