"""Tests for hiding browse folders that hold nothing importable."""

from __future__ import annotations

import time
from collections.abc import Iterator
from types import SimpleNamespace

import pytest

from ...api.errors import DomainError
from ...connectors import pruning
from ...connectors.base import Entry
from ...connectors.vault import ConnectorSecret


@pytest.fixture(autouse=True)
def _fresh_cache() -> Iterator[None]:
    """Start and end every test with empty listing, verdict and index caches."""
    clear_caches()
    yield
    settle_indexes()
    clear_caches()


def clear_caches() -> None:
    """Forget every cached listing, verdict and index."""
    pruning._listings.clear()
    pruning._verdicts.clear()
    pruning._indexes.clear()


def settle_indexes() -> None:
    """Wait for background index builds to finish."""
    deadline = time.monotonic() + 5
    while pruning._building and time.monotonic() < deadline:
        time.sleep(0.01)


def _folder(ref: str) -> Entry:
    """Build a folder entry named after its ref.

    Args:
        ref: The folder ref.

    Returns:
        The entry.
    """
    return Entry(ref=ref, name=ref, kind="folder")


def _file(ref: str) -> Entry:
    """Build a file entry named after its ref.

    Args:
        ref: The file ref.

    Returns:
        The entry.
    """
    return Entry(ref=ref, name=ref, kind="file")


def _provider(tree: dict[str, list[Entry]], **attrs: object) -> tuple[SimpleNamespace, list[str]]:
    """Fake a provider module whose browse reads from ``tree``.

    Args:
        tree: Listing per location; a location mapped to ``None`` raises.
        **attrs: Extra module attributes such as ``LIST_LIMIT``.

    Returns:
        ``(module, calls)`` where ``calls`` records every browsed location.
    """
    calls: list[str] = []

    def browse(secret: ConnectorSecret, location: str, search: str) -> list[Entry]:
        """Serve one listing from the tree."""
        calls.append(location)
        listing = tree[location]
        if listing is None:
            raise DomainError("connectors.rate_limited", status=429)
        return listing

    return SimpleNamespace(PROVIDER="fake", browse=browse, **attrs), calls


def _secret() -> ConnectorSecret:
    """Build a throwaway stored credential.

    Returns:
        The secret.
    """
    return ConnectorSecret(access_token="token", refresh_token=None, expires_at=None, auth_method="token")


def test_empty_folders_are_hidden_and_files_kept() -> None:
    """A folder with only empty subfolders goes; one with a nested file stays."""
    module, _ = _provider(
        {
            "": [_folder("docs"), _folder("data"), _folder("bare"), _file("top.csv")],
            "docs": [_folder("docs/old")],
            "docs/old": [],
            "data": [_folder("data/raw")],
            "data/raw": [_file("data/raw/train.csv")],
            "bare": [],
        }
    )
    entries = pruning.browse_importable(module, _secret(), "", "")
    assert [e.ref for e in entries] == ["data", "top.csv"]


def test_unknown_folders_stay_visible() -> None:
    """Failures, capped listings and deep trees are unknown, so the folder stays."""
    deep = {f"deep/{'x/' * i}": [_folder(f"deep/{'x/' * (i + 1)}")] for i in range(pruning.PROBE_LISTINGS_PER_FOLDER)}
    module, _ = _provider(
        {
            "": [_folder("broken"), _folder("capped"), _folder("deep/")],
            "broken": None,
            "capped": [_folder("capped/a"), _folder("capped/b")],
            **deep,
        },
        LIST_LIMIT=2,
    )
    entries = pruning.browse_importable(module, _secret(), "", "")
    assert [e.ref for e in entries] == ["broken", "capped", "deep/"]


def test_verdicts_are_cached_per_credential() -> None:
    """A second listing reuses the verdicts instead of probing again."""
    module, calls = _provider({"": [_folder("a")], "a": []})
    assert pruning.browse_importable(module, _secret(), "", "") == []
    pruning._listings.clear()
    assert pruning.browse_importable(module, _secret(), "", "") == []
    assert calls == ["", "a", ""]


def test_opening_a_probed_folder_reuses_the_probe_listing() -> None:
    """The probes' listings are cached, so clicking into a probed folder costs no provider call."""
    module, calls = _provider({"": [_folder("a")], "a": [_file("a/x.csv")]})
    pruning.browse_importable(module, _secret(), "", "")
    assert [e.ref for e in pruning.browse_importable(module, _secret(), "a", "")] == ["a/x.csv"]
    assert calls == ["", "a"]


def test_searches_bypass_the_listing_cache() -> None:
    """A search always reaches the provider, which does the filtering."""
    module, calls = _provider({"": [_file("x.csv")]})
    pruning.browse_importable(module, _secret(), "", "")
    pruning.browse_importable(module, _secret(), "", "x")
    assert calls == ["", ""]


def test_a_provider_subtree_check_replaces_the_walk() -> None:
    """A provider that settles a whole subtree in one call is asked instead of listing folder by folder."""
    module, calls = _provider({"": [_folder("a"), _folder("b")]})
    module.has_importable = lambda secret, ref: ref == "b"
    assert [e.ref for e in pruning.browse_importable(module, _secret(), "", "")] == ["b"]
    assert calls == [""]


def test_providers_can_opt_out() -> None:
    """A provider whose folders always hold files skips the probes."""
    module, calls = _provider({"": [_folder("project/1")]}, PRUNE_EMPTY_FOLDERS=False)
    assert [e.ref for e in pruning.browse_importable(module, _secret(), "", "")] == ["project/1"]
    assert calls == [""]


def test_provider_index_replaces_probes_once_built() -> None:
    """The first listing is answered by probes while the index builds; later ones use the index alone."""
    module, calls = _provider({"": [_folder("a"), _folder("b")], "a": None, "b": None})
    module.importable_folders = lambda secret: {"b"}
    assert [e.ref for e in pruning.browse_importable(module, _secret(), "", "")] == ["a", "b"]
    settle_indexes()
    calls.clear()
    assert [e.ref for e in pruning.browse_importable(module, _secret(), "", "")] == ["b"]
    assert calls == []


def test_failed_index_falls_back_to_probes() -> None:
    """An index that errors or gives up leaves the per-folder probes in charge."""
    module, _ = _provider({"": [_folder("a"), _folder("b")], "a": [], "b": [_file("b/x.csv")]})

    def broken(secret: ConnectorSecret) -> set[str]:
        """Fail like a rate-limited provider."""
        raise DomainError("connectors.rate_limited", status=429)

    module.importable_folders = broken
    assert [e.ref for e in pruning.browse_importable(module, _secret(), "", "")] == ["b"]
    settle_indexes()
    assert [e.ref for e in pruning.browse_importable(module, _secret(), "", "")] == ["b"]


def test_failed_index_is_not_rebuilt_on_every_listing() -> None:
    """A drive too large to index is not re-queried until the cached failure expires."""
    module, _ = _provider({"": [_folder("a")], "a": [_file("a/x.csv")]})
    builds: list[int] = []
    module.importable_folders = lambda secret: builds.append(1)
    for _ in range(3):
        pruning.browse_importable(module, _secret(), "", "")
        settle_indexes()
    assert builds == [1]


def test_an_empty_folder_once_opened_stays_hidden() -> None:
    """Opening a folder that turns out empty hides it from the parent next time."""
    module, _ = _provider({"": [_folder("a")], "a": None})
    assert [e.ref for e in pruning.browse_importable(module, _secret(), "", "")] == ["a"]
    module.browse = lambda secret, location, search: {"": [_folder("a")], "a": []}[location]
    assert pruning.browse_importable(module, _secret(), "a", "") == []
    assert pruning.browse_importable(module, _secret(), "", "") == []
