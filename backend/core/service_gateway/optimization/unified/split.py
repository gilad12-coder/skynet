"""Split a unified run's cases into train, validation and test, server side.

This is the one place the held-out split is decided. Engines receive the
train cases and the validation cases; selection (the winner and the
regression guard) runs on validation, falling back to train when there is
none; the reported scores are measured on test, falling back to validation.
Test cases never reach an engine, a proposer or the contract check.
"""

from __future__ import annotations

import hashlib
import json
import random
from collections import Counter
from dataclasses import dataclass
from typing import Any

from ....models.blackbox import UnifiedSplitCounts
from ....models.common import SplitFractions
from ....models.unified import MIN_PAIRS_FOR_HELD_OUT, DataMode, PinnedSplit, UnifiedCase, UnifiedRunRequest
from ...datasets.split_counts import split_counts


@dataclass(frozen=True)
class CaseSplits:
    """A run's cases split for search (train), selection (val) and reporting (test)."""

    train: list[UnifiedCase]
    val: list[UnifiedCase]
    test: list[UnifiedCase]
    counts: UnifiedSplitCounts


def _case_json(case: Any) -> Any:
    """Return a JSON-ready form of one case.

    Args:
        case: A :class:`UnifiedCase` or a raw case mapping.

    Returns:
        The case as plain data.
    """
    return case.model_dump(mode="json") if isinstance(case, UnifiedCase) else case


def case_key(case: Any) -> str:
    """Identify one case by its content, for pinning it to a split.

    A raw mapping is read as a :class:`UnifiedCase` first, so a case read
    back from a stored request and the same case inside a run share one key.

    Args:
        case: A :class:`UnifiedCase` or a raw case mapping.

    Returns:
        The first 16 hex digits of the sha256 of the case's canonical JSON.
    """
    body = UnifiedCase.model_validate(case).model_dump(mode="json") if isinstance(case, dict) else _case_json(case)
    canonical = json.dumps(body, sort_keys=True, separators=(",", ":"), ensure_ascii=False, default=str)
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()[:16]


def task_fingerprint(payload: UnifiedRunRequest) -> str:
    """Hash what decides a run's split: its cases, objective and artifact.

    The split seed comes from this, never from the optimization id, so a
    resubmitted identical task gets the identical split.

    Args:
        payload: The unified run.

    Returns:
        The sha256 hex digest of the canonical JSON of the cases (or the
        staged dataset id when cases travel by reference), the objective and
        the artifact.
    """
    cases = payload.data.cases
    body = {
        "cases": [_case_json(case) for case in cases] if cases is not None else None,
        "staged_dataset_id": payload.data.staged_dataset_id if cases is None else None,
        "objective": payload.task.objective,
        "artifact": payload.task.artifact.model_dump(mode="json"),
    }
    canonical = json.dumps(body, sort_keys=True, separators=(",", ":"), ensure_ascii=False, default=str)
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def split_seed(payload: UnifiedRunRequest) -> int:
    """Return the run's split seed: its explicit seed, else one derived from the task.

    Args:
        payload: The unified run.

    Returns:
        A non-negative 31-bit seed, byte-stable across processes.
    """
    if payload.seed is not None:
        return payload.seed
    digest = hashlib.sha256(task_fingerprint(payload).encode("utf-8")).digest()
    return int.from_bytes(digest[:4], "big") % (2**31)


def split_cases(
    cases: list[UnifiedCase],
    mode: DataMode,
    fractions: SplitFractions,
    *,
    shuffle: bool,
    seed: int,
    pinned: PinnedSplit | None = None,
) -> CaseSplits:
    """Split ``cases`` deterministically for search, selection and reporting.

    Single mode (one case) uses that case everywhere and holds nothing out.
    In pairs mode the counts follow ``fractions`` (largest remainder, as the
    wizard shows them); below :data:`MIN_PAIRS_FOR_HELD_OUT` cases there is no
    test split and the train and validation fractions share every case.

    Args:
        cases: The run's cases, in submitted order.
        mode: ``"single"`` or ``"pairs"``.
        fractions: Train/val/test fractions summing to 1.0.
        shuffle: Whether to shuffle (with ``seed``) before slicing.
        seed: RNG seed for the shuffle.
        pinned: Roles earlier runs of a scheduled plan already gave some cases.

    Returns:
        The three splits and their counts.
    """
    ordered = list(cases)
    if mode == "single" or len(ordered) <= 1:
        return CaseSplits(
            train=ordered,
            val=list(ordered),
            test=list(ordered),
            counts=UnifiedSplitCounts(
                train=len(ordered),
                val=len(ordered),
                test=len(ordered),
                held_out=False,
                selection_split="all",
                report_split="all",
            ),
        )
    if pinned is not None:
        return _pinned_split(ordered, fractions, shuffle=shuffle, seed=seed, pinned=pinned)
    if shuffle:
        random.Random(seed).shuffle(ordered)
    if len(ordered) < MIN_PAIRS_FOR_HELD_OUT:
        fractions = _search_fractions(fractions)
    counts = split_counts(len(ordered), fractions)
    val_end = counts.train + counts.val
    train, val, test = ordered[: counts.train], ordered[counts.train : val_end], ordered[val_end:]
    return _splits(train, val, test)


def _search_fractions(fractions: SplitFractions) -> SplitFractions:
    """Spread the train and validation fractions over every case, holding none out.

    Args:
        fractions: The run's fractions.

    Returns:
        Fractions with no test share.
    """
    searchable = fractions.train + fractions.val
    if searchable <= 0:
        return SplitFractions(train=1.0, val=0.0, test=0.0)
    return SplitFractions(train=fractions.train / searchable, val=fractions.val / searchable, test=0.0)


def _pinned_split(
    cases: list[Any], fractions: SplitFractions, *, shuffle: bool, seed: int, pinned: PinnedSplit
) -> CaseSplits:
    """Split cases so the ones earlier runs used keep their role.

    Pinned test cases stay held out and pinned search cases never become test
    cases, so no version is scored on a case an optimizer already saw. Only
    new cases are split by ``fractions``, so the test set grows with the data.
    A pinned case the data no longer has simply drops out.

    Args:
        cases: The run's cases.
        fractions: Train/val/test fractions for the new cases.
        shuffle: Whether to shuffle (with ``seed``) before slicing.
        seed: RNG seed for the shuffle.
        pinned: The keys of the earlier test and search cases.

    Returns:
        The three splits and their counts.
    """
    # A pin repeats a key once per identical case, so copies split across roles keep those roles.
    test_keys, fit_keys = Counter(pinned.test), Counter(pinned.fit)
    test: list[Any] = []
    fit: list[Any] = []
    new: list[Any] = []
    for case in cases:
        key = case_key(case)
        if test_keys[key] > 0:
            test_keys[key] -= 1
            test.append(case)
        elif fit_keys[key] > 0:
            fit_keys[key] -= 1
            fit.append(case)
        else:
            new.append(case)
    if shuffle:
        rng = random.Random(seed)
        rng.shuffle(fit)
        rng.shuffle(new)
    counts = split_counts(len(new), fractions)
    searched = counts.train + counts.val
    test += new[searched:]
    pool = fit + new[:searched]
    pool_counts = split_counts(len(pool), _search_fractions(fractions))
    return _splits(pool[: pool_counts.train], pool[pool_counts.train :], test)


def _splits(train: list[Any], val: list[Any], test: list[Any]) -> CaseSplits:
    """Wrap three slices with their counts.

    Args:
        train: Search cases.
        val: Selection cases.
        test: Held-out cases.

    Returns:
        The splits and their counts.
    """
    # Engines search on train; a split with no train fraction searches on
    # its validation cases and then selects on them too.
    if not train:
        train, val = val, []
    return CaseSplits(
        train=train,
        val=val,
        test=test,
        counts=UnifiedSplitCounts(
            train=len(train),
            val=len(val),
            test=len(test),
            held_out=bool(test),
            selection_split="val" if val else "train",
            report_split="test" if test else ("val" if val else "all"),
        ),
    )


def selection_cases(splits: CaseSplits) -> list[UnifiedCase]:
    """Return the cases the winner and the regression guard are chosen on.

    Args:
        splits: The run's splits.

    Returns:
        Validation cases, or the train cases when there are none.
    """
    return splits.val or splits.train


def report_cases(splits: CaseSplits) -> list[UnifiedCase]:
    """Return the cases the final scores are reported on.

    Args:
        splits: The run's splits.

    Returns:
        Test cases, else validation cases, else the train cases.
    """
    return splits.test or splits.val or splits.train


def report_matches_selection(splits: CaseSplits) -> bool:
    """Return whether reporting reuses the selection cases, so one scoring pass serves both.

    Args:
        splits: The run's splits.

    Returns:
        True when the report and selection splits are the same cases.
    """
    return selection_cases(splits) == report_cases(splits)


def contract_samples(splits: CaseSplits, k: int) -> list[UnifiedCase]:
    """Pick up to ``k`` cases for the contract check, never from the test split.

    Args:
        splits: The run's splits.
        k: How many samples to take.

    Returns:
        The first ``k`` distinct cases of train then validation.
    """
    samples: list[UnifiedCase] = []
    for case in [*splits.train, *splits.val]:
        if len(samples) >= k:
            break
        if not any(case is seen for seen in samples):
            samples.append(case)
    return samples
