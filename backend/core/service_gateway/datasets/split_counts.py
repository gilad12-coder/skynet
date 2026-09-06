"""Turn split fractions into whole-example counts that use every row.

Fractions rarely divide a dataset evenly. The counts come from the
largest-remainder method: each split takes the whole examples its fraction
covers, and the rows left over go to the splits whose fractions were cut
the most, so the three counts always add up to the dataset. Two rules sit
on top: a split with a non-zero fraction always gets at least one example,
taken from the largest split if need be, and a split with a zero fraction
never gets any. The submit wizard mirrors this in
``frontend/src/features/submit/lib/split-example-counts.ts`` so the counts
it shows under the manual fields are the ones the run will use.
"""

from __future__ import annotations

import math

from ...models.common import SplitCounts, SplitFractions


def split_counts(total: int, fractions: SplitFractions) -> SplitCounts:
    """Allocate ``total`` examples across train, val and test.

    Args:
        total: Number of examples in the dataset.
        fractions: Train/val/test fractions summing to 1.0.

    Returns:
        Whole-example counts that add up to ``total``. When the dataset has
        fewer examples than there are non-zero fractions, the smallest
        fractions go without.
    """
    counts = _allocate(max(total, 0), (fractions.train, fractions.val, fractions.test))
    return SplitCounts(train=counts[0], val=counts[1], test=counts[2])


def _allocate(total: int, shares: tuple[float, ...]) -> list[int]:
    """Apportion ``total`` across ``shares`` by largest remainder with a floor of one.

    Args:
        total: Number of examples to hand out.
        shares: Fractions summing to 1.0, in split order.

    Returns:
        One count per share, adding up to ``total``.
    """
    exact = [total * share for share in shares]
    counts = [max(math.floor(value), 1) if share > 0 else 0 for value, share in zip(exact, shares, strict=True)]
    held = [index for index, share in enumerate(shares) if share > 0]
    shortfall = total - sum(counts)
    while shortfall > 0:
        counts[max(held, key=lambda index: exact[index] - counts[index])] += 1
        shortfall -= 1
    # The one-example floors can overdraw a tiny dataset: the largest split
    # gives one back, and once every split is down to one the smallest shares
    # go without, later splits first. ``max`` keeps the first of tied entries.
    while shortfall < 0:
        above_floor = [index for index, count in enumerate(counts) if count > 1]
        if above_floor:
            counts[max(above_floor, key=lambda index: counts[index])] -= 1
        else:
            holding = [index for index in reversed(range(len(counts))) if counts[index] > 0]
            counts[max(holding, key=lambda index: -shares[index])] -= 1
        shortfall += 1
    return counts
