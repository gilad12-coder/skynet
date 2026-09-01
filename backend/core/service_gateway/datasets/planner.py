"""Turn a dataset profile into a recommended split plan.

Given a ``DatasetProfile``, pick train/val/test fractions purely from the
example count and assemble a human-readable rationale. The output
``SplitPlan`` is surfaced by ``POST /datasets/profile``; the submit
wizard renders it as the "we'll split it like this" card and the user
either accepts the fractions or overrides them before sending the real
job payload.

The fractions are tuned for DSPy GEPA, which inverts the classical
prompt-optimizer ratio. DSPy's optimization overview explicitly notes
that GEPA "follows the more standard ML convention: maximize the
training set, while keeping the validation set just large enough to
reflect the distribution of the downstream tasks." Trainset (D_feedback)
drives reflective mutation; valset (D_pareto) is a fixed holdout used
to score every candidate against the Pareto frontier. GEPA accepts
val=trainset as a fallback for tiny corpora — formally allowed but
discouraged when more data exists.

The tier thresholds below are anchored to published GEPA tutorials —
the facility-support analyzer ran on 14/10/10, the HF cookbook on
112/22/90, AIME on 33/33/34 — and to DSPy's documented "substantial
value out of 30 examples" floor. We deliberately do not branch on
column type or class balance: GEPA's reflection LM consumes free-form
trajectories and the Pareto frontier scores against an aggregate
metric, so per-class stratified sampling buys nothing here. Pure
size-based splitting is simpler, defensible, and matches every
published GEPA configuration we found.

Black-box engines consume the split differently, so ``recommend_split``
takes an optional ``engine`` hint. Best-of-N never trains — it ranks every
proposal on the val set and ignores train — so its plan pushes the data
into val (capped, so each proposal stays affordable) and keeps a test
holdout. Meta-Harness evaluates every candidate on train and val pooled
together, so a val slice buys nothing and only test is a true holdout.
GEPA and the auto / plateau lanes keep the tiers above.
"""

from __future__ import annotations

import random

from ...i18n import t
from ...models.blackbox import BLACKBOX_ENGINE_BEST_OF_N, BLACKBOX_ENGINE_META_HARNESS
from ...models.common import SplitCounts, SplitFractions
from ...models.dataset import DatasetProfile, SplitPlan

TIER_TINY = 30
TIER_SMALL = 80
TIER_MEDIUM = 300

VAL_CAP = 200
TEST_CAP = 500


def recommend_split(
    profile: DatasetProfile, *, seed: int | None = None, engine: str | None = None
) -> SplitPlan:
    """Return a recommended ``SplitPlan`` for the profiled dataset.

    When ``seed`` is omitted a fresh random seed is chosen so the plan is
    still fully specified. ``engine`` shifts the fractions towards the sets
    the named black-box engine actually scores on; unknown or missing
    engines get the GEPA-tuned default.

    Args:
        profile: The dataset profile produced by the profiler.
        seed: Optional deterministic seed; when ``None`` a random seed is chosen.
        engine: Optional black-box engine id the split will feed.

    Returns:
        A fully-populated :class:`SplitPlan` describing fractions, counts,
        seed, engine, and rationale.
    """
    total = profile.row_count
    fractions = _recommend_fractions(total, engine)
    counts = _compute_counts(total, fractions)
    resolved_seed = seed if seed is not None else random.Random().randint(0, 2**31 - 1)

    return SplitPlan(
        fractions=fractions,
        shuffle=True,
        seed=resolved_seed,
        counts=counts,
        engine=engine,
        rationale=_build_rationale(total, counts, engine),
    )


def _recommend_fractions(total: int, engine: str | None = None) -> SplitFractions:
    """Pick train/val/test fractions sized to GEPA's documented sweet spots.

    Below ``TIER_TINY`` every engine gets the whole dataset in train;
    above it Best-of-N and Meta-Harness branch to their own policies (see
    ``_best_of_n_fractions`` / ``_meta_harness_fractions``) and everything
    else follows the GEPA tiers.

    Tier policy (research-grounded; see module docstring for citations):

    * ``total < 30``  — all train (val=test=0). GEPA falls back to using
      the trainset as the valset; documented as legal-but-discouraged
      and the only viable option for tutorial-scale corpora.
    * ``30 <= total < 80`` — 80/20/0. Enough to give GEPA a true holdout
      valset for Pareto scoring; a test slice would starve training.
    * ``80 <= total < 300`` — 60/20/20. Standard 3-way split where val
      and test are both large enough (≥16 / ≥16) for stable scoring.
    * ``total >= 300`` — 60/20/20 with val capped at ``VAL_CAP`` and
      test capped at ``TEST_CAP``. DSPy's GEPA notes call out a ~35
      example threshold below which further valset reduction is
      unhelpful; the cap keeps optimizer compute bounded once the
      valset is "large enough to reflect the distribution."

    Args:
        total: Total number of rows in the dataset.
        engine: Optional black-box engine id the split will feed.

    Returns:
        Recommended train/val/test fractions summing to 1.0.
    """
    if total < TIER_TINY:
        return SplitFractions(train=1.0, val=0.0, test=0.0)
    if engine == BLACKBOX_ENGINE_BEST_OF_N:
        return _best_of_n_fractions(total)
    if engine == BLACKBOX_ENGINE_META_HARNESS:
        return _meta_harness_fractions(total)
    if total < TIER_SMALL:
        return SplitFractions(train=0.80, val=0.20, test=0.0)
    if total < TIER_MEDIUM:
        return SplitFractions(train=0.60, val=0.20, test=0.20)

    val_fraction = round(min(0.20, VAL_CAP / total), 4)
    test_fraction = round(min(0.20, TEST_CAP / total), 4)
    train_fraction = round(1.0 - val_fraction - test_fraction, 4)
    val_fraction = round(1.0 - train_fraction - test_fraction, 4)
    return SplitFractions(train=train_fraction, val=val_fraction, test=test_fraction)


def _best_of_n_fractions(total: int) -> SplitFractions:
    """Size the split for Best-of-N, which only ever scores on val.

    Best-of-N samples proposals and ranks them on the val set (falling back
    to train only when val is empty), so train buys nothing. Below
    ``TIER_MEDIUM`` everything goes 0/80/20; above it val is capped at
    ``VAL_CAP`` so each proposal stays affordable and the untouched
    remainder is parked in train.

    Args:
        total: Total number of rows in the dataset (at least ``TIER_TINY``).

    Returns:
        Recommended train/val/test fractions summing to 1.0.
    """
    if total < TIER_MEDIUM:
        return SplitFractions(train=0.0, val=0.80, test=0.20)

    val_fraction = round(min(0.80, VAL_CAP / total), 4)
    test_fraction = round(min(0.20, TEST_CAP / total), 4)
    train_fraction = round(1.0 - val_fraction - test_fraction, 4)
    val_fraction = round(1.0 - train_fraction - test_fraction, 4)
    return SplitFractions(train=train_fraction, val=val_fraction, test=test_fraction)


def _meta_harness_fractions(total: int) -> SplitFractions:
    """Size the split for Meta-Harness, which pools train and val.

    Meta-Harness evaluates every candidate harness on train and val
    together, so a separate val slice would only shrink the pool. Only
    test is a genuine holdout; it is capped at ``TEST_CAP`` like the
    default tiers.

    Args:
        total: Total number of rows in the dataset (at least ``TIER_TINY``).

    Returns:
        Recommended train/val/test fractions summing to 1.0.
    """
    test_fraction = round(min(0.20, TEST_CAP / total), 4)
    train_fraction = round(1.0 - test_fraction, 4)
    return SplitFractions(train=train_fraction, val=0.0, test=test_fraction)


def _compute_counts(total: int, fractions: SplitFractions) -> SplitCounts:
    """Convert fractional sizes into integer counts that sum to ``total``.

    Rounds train and val down; test absorbs the remainder so the three
    counts always sum exactly to ``total``. No floor logic — the new
    tier policy already guarantees test=0 when the dataset can't
    afford a meaningful holdout.

    Args:
        total: Total number of rows in the dataset.
        fractions: Recommended train/val/test fractions.

    Returns:
        :class:`SplitCounts` with train+val+test == total.
    """
    train = int(total * fractions.train)
    val = int(total * fractions.val)
    if fractions.test == 0:
        train = total - val
        return SplitCounts(train=train, val=val, test=0)
    test = total - train - val
    return SplitCounts(train=train, val=val, test=test)


def _build_rationale(total: int, counts: SplitCounts, engine: str | None = None) -> list[str]:
    """Build short Hebrew rationale bullets explaining the chosen tier.

    Args:
        total: Total dataset size.
        counts: Per-split row counts produced by ``_compute_counts``.
        engine: Optional black-box engine id the split was sized for.

    Returns:
        A list of short Hebrew bullet strings describing the plan.
    """
    if engine == BLACKBOX_ENGINE_BEST_OF_N:
        return [_best_of_n_rationale(total, counts)]
    if engine == BLACKBOX_ENGINE_META_HARNESS:
        return [_meta_harness_rationale(total, counts)]
    if total < TIER_TINY:
        return [t("dataset.split.rationale.tiny", total=total)]
    if total < TIER_SMALL:
        return [t("dataset.split.rationale.small", total=total)]
    if total < TIER_MEDIUM:
        return [t("dataset.split.rationale.medium", total=total)]
    return [
        t(
            "dataset.split.rationale.large",
            total=total,
            val_count=counts.val,
            test_count=counts.test,
        )
    ]


def _best_of_n_rationale(total: int, counts: SplitCounts) -> str:
    """Explain a Best-of-N plan: everything scores on val, test checks the winner.

    Args:
        total: Total dataset size.
        counts: Per-split row counts produced by ``_compute_counts``.

    Returns:
        A single rationale bullet.
    """
    if total < TIER_TINY:
        return t("dataset.split.rationale.best_of_n.pooled", total=total)
    if counts.train:
        return t(
            "dataset.split.rationale.best_of_n.capped",
            total=total,
            train_count=counts.train,
            val_count=counts.val,
            test_count=counts.test,
        )
    return t(
        "dataset.split.rationale.best_of_n.holdout",
        total=total,
        val_count=counts.val,
        test_count=counts.test,
    )


def _meta_harness_rationale(total: int, counts: SplitCounts) -> str:
    """Explain a Meta-Harness plan: train and val are pooled, test is the holdout.

    Args:
        total: Total dataset size.
        counts: Per-split row counts produced by ``_compute_counts``.

    Returns:
        A single rationale bullet.
    """
    if total < TIER_TINY:
        return t("dataset.split.rationale.meta_harness.pooled", total=total)
    return t(
        "dataset.split.rationale.meta_harness.holdout",
        total=total,
        train_count=counts.train,
        test_count=counts.test,
    )
