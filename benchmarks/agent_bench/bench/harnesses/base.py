"""Shared result type and pricing for every harness adapter."""

from __future__ import annotations

from dataclasses import asdict, dataclass
from typing import Any

MODEL = "deepseek/deepseek-v4.1-flash"

# OpenRouter base list price per token for MODEL. Every harness is costed from
# its own token counts at these rates, because the harnesses' self-reported
# costs use different (sometimes wrong) price tables.
PRICE_FRESH_INPUT = 0.15e-6
PRICE_CACHED_INPUT = 0.003e-6
PRICE_OUTPUT = 0.60e-6


@dataclass
class Attempt:
    """What a harness produced for one task, in harness-neutral units."""

    answer: str = ""
    fresh_input_tokens: int = 0
    cached_input_tokens: int = 0
    output_tokens: int = 0
    llm_calls: int = 0
    error: str = ""

    @property
    def cost_usd(self) -> float:
        """Return the list-price cost of this attempt's tokens."""
        return (
            self.fresh_input_tokens * PRICE_FRESH_INPUT
            + self.cached_input_tokens * PRICE_CACHED_INPUT
            + self.output_tokens * PRICE_OUTPUT
        )

    def as_dict(self) -> dict[str, Any]:
        """Return the attempt as a JSON-ready dict including the derived cost."""
        return {**asdict(self), "cost_usd": round(self.cost_usd, 6)}
