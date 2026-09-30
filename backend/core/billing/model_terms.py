"""Models Skynet does not run on its own provider account because of their license terms.

Gemma's terms treat hosted access as distribution and require its use
restrictions to be enforceable against every end user, and Llama's license
adds attribution and acceptable-use flow-down. Skynet's customer agreement
does not carry those terms, so these families run only on a customer's own
key, where the customer is the licensee.
"""

from __future__ import annotations

import json
import re

_LICENSED_FAMILY_RE = re.compile(r"(^|/)(gemma|[^/]*llama)", re.IGNORECASE)
_SELF_HOSTED_PREFIXES = ("ollama/", "ollama_chat/")


def excluded_from_managed(model: str) -> bool:
    """Return whether a model id belongs to a family withheld from platform-paid runs.

    Args:
        model: Catalog or provider model id, with or without a provider prefix.

    Returns:
        ``True`` for Gemma and Llama models, including Llama derivatives.
    """
    name = model.strip().lower()
    if name.startswith(_SELF_HOSTED_PREFIXES):
        return False
    return bool(_LICENSED_FAMILY_RE.search(name))


def managed_model_refusal(model: str) -> bytes:
    """Explain why a platform-paid call to a withheld model family was refused.

    Args:
        model: The refused model id.

    Returns:
        A relay error body the SDK surfaces like a provider error.
    """
    message = (
        f"{model} is available only with your own provider key, because its license terms must bind "
        "the end user directly. Add a key in Settings, or choose another model."
    )
    return json.dumps({"error": {"type": "model_requires_own_key", "message": message}}).encode()
