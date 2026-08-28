"""The ``llm()`` helper a python scorer may call.

A scorer often has to *run* the version under optimization — a prompt has
no score until a model answers with it. Rather than hand user code raw
provider credentials, the worker and the dry-run sandbox inject one
callable, ``llm(prompt, input=None)``, bound to the model chosen in the
Scorer step. Its token usage is read back from the wrapped ``dspy.LM`` so
the run bills it alongside the reflection model.
"""

from __future__ import annotations

import dspy

from ....models.common import ModelConfig
from ...language_models import build_language_model


class ScorerLLM:
    """What the scorer sees as ``llm``: one chat completion per call."""

    def __init__(self, lm: dspy.LM) -> None:
        """Wrap a language model.

        Args:
            lm: The model the scorer's calls go to; exposed as ``lm`` so the
                run can harvest its usage.
        """
        self.lm = lm

    def __call__(self, prompt: str, input: str | None = None) -> str:
        """Complete ``prompt``, optionally as a system message over ``input``.

        Args:
            prompt: The text to run; with ``input`` it is the system message
                (the prompt under optimization), alone it is the user message.
            input: The case's input, sent as the user message when given.

        Returns:
            The model's first completion, as text.
        """
        if input is None:
            messages = [{"role": "user", "content": str(prompt)}]
        else:
            messages = [{"role": "system", "content": str(prompt)}, {"role": "user", "content": str(input)}]
        completions = self.lm(messages=messages)
        return str(completions[0]) if completions else ""


def build_scorer_llm(config: ModelConfig) -> ScorerLLM:
    """Build the scorer's ``llm`` helper over the chosen model.

    The client-side cache stays on: a scorer that runs the same version on
    the same case twice should see the same answer, and pay once.

    Args:
        config: The model chosen in the Scorer step.

    Returns:
        The helper to inject into the scorer namespace.
    """
    return ScorerLLM(build_language_model(config))
