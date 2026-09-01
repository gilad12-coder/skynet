"""Tests for ``core.service_gateway.datasets.planner.recommend_split``."""

from __future__ import annotations

from core.i18n import t
from core.models import DatasetProfile
from core.models.blackbox import (
    BLACKBOX_ENGINE_BEST_OF_N,
    BLACKBOX_ENGINE_GEPA,
    BLACKBOX_ENGINE_META_HARNESS,
)
from core.service_gateway.datasets.planner import (
    TEST_CAP,
    TIER_MEDIUM,
    TIER_SMALL,
    TIER_TINY,
    VAL_CAP,
    recommend_split,
)


def _profile(row_count: int) -> DatasetProfile:
    """Build a minimal ``DatasetProfile`` at the requested row count."""
    return DatasetProfile(row_count=row_count, column_count=2)


def test_recommend_split_tiny_tier_assigns_everything_to_train() -> None:
    """Datasets below ``TIER_TINY`` go fully to train (val=test=0)."""
    plan = recommend_split(_profile(TIER_TINY - 1), seed=42)

    assert plan.fractions.train == 1.0
    assert plan.fractions.val == 0.0
    assert plan.fractions.test == 0.0
    assert plan.counts.train == TIER_TINY - 1
    assert plan.counts.val == 0
    assert plan.counts.test == 0


def test_recommend_split_small_tier_uses_80_20_with_no_test() -> None:
    """``TIER_TINY <= N < TIER_SMALL`` splits 80/20/0 — train + val only."""
    plan = recommend_split(_profile(TIER_SMALL - 1), seed=42)

    assert plan.fractions.train == 0.80
    assert plan.fractions.val == 0.20
    assert plan.fractions.test == 0.0
    assert plan.counts.test == 0


def test_recommend_split_medium_tier_uses_60_20_20() -> None:
    """``TIER_SMALL <= N < TIER_MEDIUM`` splits 60/20/20 — full three-way."""
    plan = recommend_split(_profile(TIER_MEDIUM - 1), seed=42)

    assert plan.fractions.train == 0.60
    assert plan.fractions.val == 0.20
    assert plan.fractions.test == 0.20
    assert plan.counts.val > 0
    assert plan.counts.test > 0


def test_recommend_split_large_tier_caps_val_and_test_counts() -> None:
    """Datasets at/above ``TIER_MEDIUM`` cap val at ``VAL_CAP`` and test at ``TEST_CAP``."""
    plan = recommend_split(_profile(100_000), seed=42)

    assert plan.counts.val == VAL_CAP
    assert plan.counts.test == TEST_CAP
    assert plan.counts.train == 100_000 - VAL_CAP - TEST_CAP


def test_recommend_split_counts_sum_to_total() -> None:
    """Split counts sum exactly to the row count for several dataset sizes."""
    for total in (10, 50, 150, 999, 4_321, 25_000):
        plan = recommend_split(_profile(total), seed=7)
        assert plan.counts.train + plan.counts.val + plan.counts.test == total


def test_recommend_split_fractions_sum_to_one() -> None:
    """Plan fractions sum to 1.0 for every tier."""
    for total in (10, 50, 200, 5_000, 50_000):
        plan = recommend_split(_profile(total), seed=0)
        total_frac = plan.fractions.train + plan.fractions.val + plan.fractions.test
        assert abs(total_frac - 1.0) < 1e-6


def test_recommend_split_honors_provided_seed() -> None:
    """A caller-supplied seed is propagated to the plan."""
    plan = recommend_split(_profile(500), seed=12345)

    assert plan.seed == 12345


def test_recommend_split_generates_seed_when_none() -> None:
    """Without an explicit seed, the planner generates a non-negative one."""
    plan = recommend_split(_profile(500))

    assert plan.seed >= 0


def test_recommend_split_shuffle_is_true_by_default() -> None:
    """The default plan enables shuffling."""
    plan = recommend_split(_profile(500), seed=42)

    assert plan.shuffle is True


def test_recommend_split_emits_single_rationale_bullet_per_tier() -> None:
    """Each tier emits exactly one rationale bullet describing its policy."""
    for total in (10, 50, 150, 5_000):
        plan = recommend_split(_profile(total), seed=42)
        assert len(plan.rationale) == 1
        assert plan.rationale[0].strip()


def test_recommend_split_best_of_n_puts_everything_into_val_and_test() -> None:
    """Best-of-N never trains, so mid-size datasets split 0/80/20."""
    plan = recommend_split(_profile(TIER_MEDIUM - 1), seed=42, engine=BLACKBOX_ENGINE_BEST_OF_N)

    assert plan.engine == BLACKBOX_ENGINE_BEST_OF_N
    assert plan.fractions.train == 0.0
    assert plan.fractions.val == 0.80
    assert plan.fractions.test == 0.20
    assert plan.counts.train == 0
    assert plan.counts.val + plan.counts.test == TIER_MEDIUM - 1


def test_recommend_split_best_of_n_caps_val_and_parks_the_rest_in_train() -> None:
    """Large Best-of-N datasets cap val at ``VAL_CAP`` and leave the unused remainder in train."""
    plan = recommend_split(_profile(100_000), seed=42, engine=BLACKBOX_ENGINE_BEST_OF_N)

    assert plan.counts.val == VAL_CAP
    assert plan.counts.test == TEST_CAP
    assert plan.counts.train == 100_000 - VAL_CAP - TEST_CAP


def test_recommend_split_best_of_n_tiny_tier_still_pools_everything() -> None:
    """Below ``TIER_TINY`` every engine gets the whole dataset in train."""
    plan = recommend_split(_profile(TIER_TINY - 1), seed=42, engine=BLACKBOX_ENGINE_BEST_OF_N)

    assert plan.fractions.train == 1.0
    assert plan.counts.val == 0
    assert plan.counts.test == 0
    assert plan.rationale == [t("dataset.split.rationale.best_of_n.pooled", total=TIER_TINY - 1)]


def test_recommend_split_meta_harness_skips_val_and_keeps_a_test_holdout() -> None:
    """Meta-Harness pools train and val, so only test is carved out."""
    plan = recommend_split(_profile(TIER_MEDIUM - 1), seed=42, engine=BLACKBOX_ENGINE_META_HARNESS)

    assert plan.engine == BLACKBOX_ENGINE_META_HARNESS
    assert plan.fractions.val == 0.0
    assert plan.fractions.test == 0.20
    assert plan.counts.val == 0
    assert plan.counts.train + plan.counts.test == TIER_MEDIUM - 1


def test_recommend_split_meta_harness_caps_test_count() -> None:
    """Large Meta-Harness datasets cap test at ``TEST_CAP`` and pool the rest in train."""
    plan = recommend_split(_profile(100_000), seed=42, engine=BLACKBOX_ENGINE_META_HARNESS)

    assert plan.counts.val == 0
    assert plan.counts.test == TEST_CAP
    assert plan.counts.train == 100_000 - TEST_CAP


def test_recommend_split_engine_rationale_uses_engine_specific_bullets() -> None:
    """Engine plans explain themselves with a single engine-specific bullet."""
    capped = recommend_split(_profile(100_000), seed=42, engine=BLACKBOX_ENGINE_BEST_OF_N)
    holdout = recommend_split(_profile(TIER_MEDIUM - 1), seed=42, engine=BLACKBOX_ENGINE_BEST_OF_N)
    meta = recommend_split(_profile(TIER_MEDIUM - 1), seed=42, engine=BLACKBOX_ENGINE_META_HARNESS)

    assert capped.rationale == [
        t(
            "dataset.split.rationale.best_of_n.capped",
            total=100_000,
            train_count=capped.counts.train,
            val_count=VAL_CAP,
            test_count=TEST_CAP,
        )
    ]
    assert holdout.rationale == [
        t(
            "dataset.split.rationale.best_of_n.holdout",
            total=TIER_MEDIUM - 1,
            val_count=holdout.counts.val,
            test_count=holdout.counts.test,
        )
    ]
    assert meta.rationale == [
        t(
            "dataset.split.rationale.meta_harness.holdout",
            total=TIER_MEDIUM - 1,
            train_count=meta.counts.train,
            test_count=meta.counts.test,
        )
    ]


def test_recommend_split_gepa_and_unknown_engines_keep_default_tiers() -> None:
    """GEPA and engines without a bespoke policy fall back to the GEPA-tuned tiers."""
    default = recommend_split(_profile(TIER_MEDIUM - 1), seed=42)
    gepa = recommend_split(_profile(TIER_MEDIUM - 1), seed=42, engine=BLACKBOX_ENGINE_GEPA)
    unknown = recommend_split(_profile(TIER_MEDIUM - 1), seed=42, engine="mystery")

    assert default.engine is None
    assert gepa.fractions == default.fractions
    assert unknown.fractions == default.fractions
    assert unknown.engine == "mystery"
