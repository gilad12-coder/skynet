"""Hide browse folders that are known to hold nothing importable.

A provider's ``browse`` lists every folder at a location, so a user can click
into a bucket, repo or drive folder only to find it empty of CSVs, sheets and
tables. Before a listing goes out, each folder in it is probed with the
provider's own ``browse``, breadth first and within a small budget. A folder
is dropped only when the probe proves it empty; a probe that runs out of
budget, time or luck (a rate limit, a permission error) keeps the folder, so
pruning never hides something the user could have imported.

A provider that can answer for every folder at once (Google Drive indexes the
whole drive in two queries) exposes ``importable_folders(secret)``. Building
that index takes seconds on a large drive, so it is built on a background
thread and never holds up a listing: the probes answer until it is ready.

A provider that can settle one folder's whole subtree in a single call (an
object store listing a prefix flat, GitHub reading a repository's tree)
exposes ``has_importable(secret, ref)``, which replaces the breadth-first
probe for that folder.

Listings are cached briefly, and the probes' listings go into the same cache,
so opening a folder the probes already visited costs no provider call.
"""

from __future__ import annotations

import hashlib
import threading
import time
from collections import deque
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor, wait
from types import ModuleType

from .base import Entry
from .vault import ConnectorSecret

PROBE_WORKERS = 8
PROBE_DEADLINE_SECONDS = 2.0
PROBE_LISTINGS_PER_FOLDER = 4
VERDICT_TTL_SECONDS = 300.0
INDEX_TTL_SECONDS = 900.0
LISTING_TTL_SECONDS = 60.0
LISTING_CACHE_SIZE = 2000

Lister = Callable[[str], list[Entry]]
Probe = Callable[[str], bool | None]

_verdicts: dict[tuple[str, str, str], tuple[float, bool]] = {}
_indexes: dict[tuple[str, str], tuple[float, set[str] | None]] = {}
_building: set[tuple[str, str]] = set()
_listings: dict[tuple[str, str, str], tuple[float, list[Entry]]] = {}
_verdicts_lock = threading.Lock()


def browse_importable(module: ModuleType, secret: ConnectorSecret, location: str, search: str) -> list[Entry]:
    """Browse a provider, dropping folders proven to hold no importable file.

    Args:
        module: The provider module from the registry.
        secret: The caller's stored connector.
        location: Empty for the root, else a folder ref.
        search: Optional name filter, passed through to the provider.

    Returns:
        The provider's listing minus the empty folders, order unchanged.
    """
    if not getattr(module, "PRUNE_EMPTY_FOLDERS", True):
        return module.browse(secret, location, search)
    scope = (module.PROVIDER, hashlib.sha256(secret.access_token.encode()).hexdigest())
    lister = _cached_lister(module, secret, scope)
    entries = module.browse(secret, location, search) if search else lister(location)
    if location and not entries and not search:
        _remember(scope, location, False)
    folders = [e.ref for e in entries if e.kind == "folder"]
    if not folders:
        return entries
    index = _index(module, secret, scope)
    if index is not None:
        empty = {ref for ref in folders if ref not in index}
    else:
        subtree = getattr(module, "has_importable", None)
        list_limit = getattr(module, "LIST_LIMIT", None)
        probe: Probe = (
            (lambda ref: subtree(secret, ref)) if subtree else (lambda ref: _has_importable(lister, ref, list_limit))
        )
        empty = _empty_folders(probe, folders, scope)
    return [e for e in entries if not (e.kind == "folder" and e.ref in empty)]


def _cached_lister(module: ModuleType, secret: ConnectorSecret, scope: tuple[str, str]) -> Lister:
    """Wrap a provider's unfiltered browse in the short-lived listing cache.

    Args:
        module: The provider module.
        secret: The caller's stored connector.
        scope: ``(provider, credential hash)`` keying the cache.

    Returns:
        A function listing one location, from the cache when fresh.
    """

    def list_location(location: str) -> list[Entry]:
        """List one location, reusing a fresh cached listing.

        Args:
            location: Empty for the root, else a folder ref.

        Returns:
            The provider's entries.
        """
        key = (*scope, location)
        now = time.monotonic()
        with _verdicts_lock:
            cached = _listings.get(key)
        if cached is not None and cached[0] > now:
            return cached[1]
        entries = module.browse(secret, location, "")
        with _verdicts_lock:
            if len(_listings) >= LISTING_CACHE_SIZE:
                for stale in [k for k, (expiry, _) in _listings.items() if expiry <= now]:
                    del _listings[stale]
            _listings[key] = (now + LISTING_TTL_SECONDS, entries)
        return entries

    return list_location


def _index(module: ModuleType, secret: ConnectorSecret, scope: tuple[str, str]) -> set[str] | None:
    """Return a provider's cached set of folders holding importable files.

    A missing or expired index is rebuilt on a background thread, so the
    listing that asked falls back to the probes instead of waiting for it.

    Args:
        module: The provider module.
        secret: The caller's stored connector.
        scope: ``(provider, credential hash)`` keying the cache.

    Returns:
        The folder refs, or ``None`` when the provider has no index, it is
        still building, or it failed.
    """
    build = getattr(module, "importable_folders", None)
    if build is None:
        return None
    with _verdicts_lock:
        cached = _indexes.get(scope)
        if cached is not None and cached[0] > time.monotonic():
            return cached[1]
        start = scope not in _building
        _building.add(scope)
    if start:
        threading.Thread(target=_build_index, args=(build, secret, scope), daemon=True).start()
    return None


def _build_index(
    build: Callable[[ConnectorSecret], set[str] | None], secret: ConnectorSecret, scope: tuple[str, str]
) -> None:
    """Build one provider index and cache it, failures included.

    A failure is cached too, so a drive too large to index is not re-queried
    on every listing.

    Args:
        build: The provider's ``importable_folders``.
        secret: The caller's stored connector.
        scope: ``(provider, credential hash)`` keying the cache.
    """
    try:
        index = build(secret)
    # A failed index only means the probes keep answering.
    except Exception:
        index = None
    with _verdicts_lock:
        _indexes[scope] = (time.monotonic() + INDEX_TTL_SECONDS, index)
        _building.discard(scope)


def _remember(scope: tuple[str, str], ref: str, has_files: bool) -> None:
    """Cache a definite verdict for one folder.

    Args:
        scope: ``(provider, credential hash)`` keying the cache.
        ref: The folder ref.
        has_files: Whether its subtree holds an importable file.
    """
    with _verdicts_lock:
        _verdicts[(*scope, ref)] = (time.monotonic() + VERDICT_TTL_SECONDS, has_files)


def _empty_folders(probe: Probe, refs: list[str], scope: tuple[str, str]) -> set[str]:
    """Probe folders in parallel and return the ones proven empty.

    Probes still running at the deadline carry on in the background and cache
    their verdict, so the next visit to the same listing is pruned fully.

    Args:
        probe: Settles one folder: ``True``/``False`` when known, ``None`` when not.
        refs: The folder refs to probe.
        scope: ``(provider, credential hash)`` keying the verdict cache.

    Returns:
        Refs whose subtree holds no importable file.
    """
    verdicts: dict[str, bool] = {}
    pending: list[str] = []
    now = time.monotonic()
    with _verdicts_lock:
        for ref in refs:
            cached = _verdicts.get((*scope, ref))
            if cached is not None and cached[0] > now:
                verdicts[ref] = cached[1]
            else:
                pending.append(ref)
    if pending:
        pool = ThreadPoolExecutor(max_workers=min(PROBE_WORKERS, len(pending)))
        futures = {pool.submit(_probe_and_cache, probe, ref, scope): ref for ref in pending}
        done, _ = wait(futures, timeout=PROBE_DEADLINE_SECONDS)
        pool.shutdown(wait=False)
        verdicts.update({futures[f]: f.result() for f in done if f.result() is not None})
    return {ref for ref, has_files in verdicts.items() if not has_files}


def _probe_and_cache(probe: Probe, ref: str, scope: tuple[str, str]) -> bool | None:
    """Probe one folder and remember a definite verdict.

    Args:
        probe: Settles one folder.
        ref: The folder to probe.
        scope: ``(provider, credential hash)`` keying the verdict cache.

    Returns:
        ``True`` or ``False`` when known, ``None`` when undecided.
    """
    try:
        verdict = probe(ref)
    # Any failure (rate limit, revoked scope, odd ref) only means "unknown":
    # the folder stays visible and the user sees the real error on click.
    except Exception:
        return None
    if verdict is not None:
        _remember(scope, ref, verdict)
    return verdict


def _has_importable(lister: Lister, ref: str, list_limit: int | None) -> bool | None:
    """Search a folder's subtree for an importable file, breadth first.

    Providers list only importable files, so any ``file`` entry settles it.

    Args:
        lister: Lists one folder ref.
        ref: The folder to search.
        list_limit: The provider's listing cap, or ``None`` when uncapped.

    Returns:
        ``True`` on the first file found, ``False`` once the whole subtree was
        listed without one, ``None`` when the budget ran out or a listing hit
        the provider's cap.
    """
    queue, seen = deque([ref]), {ref}
    for _ in range(PROBE_LISTINGS_PER_FOLDER):
        if not queue:
            return False
        children = lister(queue.popleft())
        if any(c.kind == "file" for c in children):
            return True
        if list_limit is not None and len(children) >= list_limit:
            return None
        for child in children:
            if child.kind == "folder" and child.ref not in seen:
                seen.add(child.ref)
                queue.append(child.ref)
    return None if queue else False
