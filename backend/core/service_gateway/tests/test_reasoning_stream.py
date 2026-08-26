"""Tests for provider reasoning-token stream normalization."""

from __future__ import annotations

from types import SimpleNamespace

from core.service_gateway.agents.code import _extract_reasoning_token


def test_reasoning_token_extracts_streamed_openrouter_summary() -> None:
    """Extract OpenRouter reasoning-summary deltas for the shared agent stream."""
    chunk = SimpleNamespace(
        choices=[
            SimpleNamespace(
                delta=SimpleNamespace(
                    reasoning_details=[
                        {
                            "type": "reasoning.summary",
                            "summary": "I compared the options.",
                        }
                    ]
                )
            )
        ]
    )

    assert _extract_reasoning_token(chunk) == "I compared the options."
