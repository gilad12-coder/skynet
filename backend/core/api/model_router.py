"""Model routing for the agent composers.

A composer that names no model runs the catalog's best-value default (see
:func:`default_model_id`), which moves with OpenRouter's live prices and
benchmarks. When the catalog flags no default (for example a gateway with no live
prices), the composer degrades to the engine's configured server default.
"""

from __future__ import annotations

import logging

from ..config import settings
from ..local.cli_catalog import CLI_MODELS, parse_subscription_model_id
from ..models import ModelConfig
from .errors import DomainError
from .interview_model import interview_model_id
from .model_catalog import (
    REASONING_EFFORTS,
    agent_model_id,
    get_catalog_cached,
    is_removed_model,
    require_known_model,
    unpicked_effort,
)

logger = logging.getLogger(__name__)

# The retired "Auto · Intelligent" menu entry; saved conversations and
# browser prefs may still send it, so it runs the default like no pick at all.
_RETIRED_AUTO_ID = "auto:intelligent"


def default_model_id() -> str | None:
    """Return the catalog's best-value default model.

    Recomputed with every catalog refresh from OpenRouter's live prices and
    benchmarks, so the default moves to a better deal without a deploy.

    Returns:
        The default model's catalog id, or ``None`` when the catalog is
        unavailable or flags no default.
    """
    try:
        catalog = get_catalog_cached()
    except Exception:
        logger.warning("model catalog unavailable; no default model", exc_info=True)
        return None
    return next((m.value for m in catalog.models if m.is_default), None)


def route_agent_model(model: str | None) -> ModelConfig:
    """Build the generalist agent's model config from the composer's pick.

    Args:
        model: Raw ``model`` value from the request; empty runs the default.

    Returns:
        A :class:`ModelConfig` on the picked model, the catalog default, or
        the configured server default when the catalog flags none.

    Raises:
        DomainError: 422 when an explicit id is not a catalog model.
    """
    name = route_menu_model(model)
    subscription = parse_subscription_model_id(name or "")
    if subscription is not None:
        cli, slug = subscription
        return ModelConfig(name=slug, token_source="subscription", cli_provider=cli)
    return ModelConfig(name=name or agent_model_id(settings.generalist_agent_model))


def effective_reasoning_effort(model: str | None, requested: str | None) -> str | None:
    """Resolve the effort to send for a turn, on the model's own effort ladder.

    The menu labels "Default" with the model's catalog default level, but an
    unset effort sends OpenRouter no ``reasoning`` param, and opt-in thinkers
    (Claude, Gemini, DeepSeek) then return no reasoning at all. Sending the
    catalog default makes the label true and the thinking visible.

    An explicit pick can come from a generic ladder (the menu's fallback
    when the catalog is unavailable), and providers reject or silently remap
    levels they don't list, so it is snapped to the nearest level the model
    declares.

    Args:
        model: The model id the turn runs on, or ``None`` when the
            engine's configured default runs.
        requested: Effort the user picked explicitly, or ``None``.

    Returns:
        The requested effort, snapped onto the model's ladder when the
        catalog knows one; otherwise :func:`unpicked_effort` of the model
        (its default effort, or low for an opt-in thinker).
    """
    if not model:
        return requested
    try:
        models = get_catalog_cached().models
    except Exception:
        return requested
    entry = next((m for m in models if m.value == model), None)
    if entry is None:
        return requested
    if requested:
        return _nearest_effort(requested, entry.reasoning_efforts)
    return unpicked_effort(entry)


def _nearest_effort(requested: str, ladder: list[str] | None) -> str:
    """Snap an effort level onto a model's declared ladder.

    Args:
        requested: The level asked for.
        ladder: The model's accepted levels, weakest first; empty or ``None``
            when the model declares none.

    Returns:
        ``requested`` when the ladder lists it, is empty, or ``requested`` is
        an unknown level; otherwise the closest listed level, the stronger
        one on a tie.
    """
    if not ladder or requested in ladder or requested not in REASONING_EFFORTS:
        return requested
    rank = REASONING_EFFORTS.index(requested)
    known = [e for e in ladder if e in REASONING_EFFORTS]
    if not known:
        return requested
    return min(known, key=lambda e: (abs(REASONING_EFFORTS.index(e) - rank), -REASONING_EFFORTS.index(e)))


def route_menu_model(model: str | None) -> str | None:
    """Resolve the composer menu's model field to the id an engine runs on.

    Args:
        model: Raw ``model`` value from the request.

    Returns:
        The validated catalog id, the catalog default when none was picked
        (or a retired / withdrawn id was sent), or ``None`` when the catalog flags no default (the engine's
        configured default runs). In local mode a ``subscription/<cli>/<slug>``
        id is returned as is.

    Raises:
        DomainError: 422 when an explicit id is not a catalog model, or names
            a subscription model its CLI cannot run.
    """
    name = str(model or "").strip()
    subscription = parse_subscription_model_id(name) if settings.local_mode else None
    if subscription is not None:
        cli, slug = subscription
        if slug not in CLI_MODELS[cli]:
            raise DomainError("billing.subscription_unmapped_model", status=422, provider=cli)
        return name
    # Saved prefs and stored conversations may still name a withdrawn model;
    # run the default instead of failing every turn with a 422.
    if name and name != _RETIRED_AUTO_ID and not is_removed_model(name):
        require_known_model(name)
        return name
    return default_model_id()


def route_interview_model(model: str | None) -> str | None:
    """Resolve an agent interview's model field, defaulting to the interview pick.

    Args:
        model: Raw ``model`` value from the request.

    Returns:
        The validated catalog id when one was picked, else the measured
        interview model (see :mod:`core.api.interview_model`).

    Raises:
        DomainError: 422 when an explicit id is not a catalog model.
    """
    name = str(model or "").strip()
    if name and name != _RETIRED_AUTO_ID and not is_removed_model(name):
        return route_menu_model(name)
    return interview_model_id()
