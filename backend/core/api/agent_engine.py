"""The per-user agent engine: which engine runs an agent turn that picks no model.

Hosted mode always runs on OpenRouter, so it never reads the stored setting.
Local mode runs agent turns on the engine the user chose: a subscription CLI,
or OpenRouter with the user's verified key. With no choice, it runs them on the
first CLI that is ready on this machine, else on the user's verified OpenRouter
key. A CLI engine never falls back to OpenRouter.
"""

from __future__ import annotations

from typing import Literal, get_args

from sqlalchemy.orm import Session

from ..billing.byok_vault import ProviderKeyVault
from ..config import settings
from ..local.cli_catalog import CLI_MODELS, CliProvider, parse_subscription_model_id
from ..local.cli_probe import CliStatus, probe_clis
from ..storage.models import AgentEnginePreferenceModel
from .model_catalog import is_removed_model
from .model_router import _RETIRED_AUTO_ID

# Droid has no flag that skips the user's own config, hooks and MCP servers,
# so it cannot run like the hosted setup and is not an engine option. A saved
# "droid" row is unknown here and falls back to the default engine.
AgentEngine = Literal["openrouter", "codex", "claude"]
AGENT_ENGINES: tuple[AgentEngine, ...] = get_args(AgentEngine)
OPENROUTER_ENGINE: AgentEngine = "openrouter"


def _ready(status: CliStatus) -> bool:
    """Return whether a CLI can take an agent turn now.

    Args:
        status: The CLI's probe result.

    Returns:
        ``True`` when it is installed, new enough, not signed out and not capped.
    """
    return (
        status.path is not None
        and status.version_ok
        and status.logged_in is not False
        and status.rate_limited_until is None
    )


def default_agent_engine() -> AgentEngine | None:
    """Return the engine a caller runs on before choosing one.

    Returns:
        ``openrouter`` in hosted mode; in local mode the first ready engine
        CLI, or ``None`` when none is ready.
    """
    if not settings.local_mode:
        return OPENROUTER_ENGINE
    return next(
        (status.id for status in probe_clis(settings) if status.id in AGENT_ENGINES and _ready(status)),
        None,
    )


def stored_agent_engine(job_store: object | None, username: str) -> AgentEngine | None:
    """Read the caller's stored engine in local mode.

    Args:
        job_store: Job store whose ORM engine holds the setting, or ``None``.
        username: The caller.

    Returns:
        The stored engine, or ``None`` in hosted mode, with no store, with no
        row, or for a value this build does not know.
    """
    if not settings.local_mode or job_store is None:
        return None
    engine = getattr(job_store, "engine", None)
    if engine is None:
        return None
    with Session(engine) as session:
        row = session.get(AgentEnginePreferenceModel, username)
    value = row.engine if row is not None else None
    return value if value in AGENT_ENGINES else None  # type: ignore[return-value]


def effective_agent_engine(job_store: object | None, username: str) -> AgentEngine | None:
    """Return the engine the caller's agent turns run on.

    Args:
        job_store: Job store whose ORM engine holds the setting, or ``None``.
        username: The caller.

    Returns:
        The stored engine, else the default (see :func:`default_agent_engine`).
        In local mode with neither, ``openrouter`` when the caller has a
        verified OpenRouter key, because the model router then runs the turn
        on that key; else ``None``.
    """
    chosen = stored_agent_engine(job_store, username) or default_agent_engine()
    if chosen is not None or not settings.local_mode:
        return chosen
    engine = getattr(job_store, "engine", None)
    if engine is not None and ProviderKeyVault(engine=engine).has_verified_connection(username, OPENROUTER_ENGINE):
        return OPENROUTER_ENGINE
    return None


def engine_agent_model(job_store: object | None, username: str, model: str | None) -> str | None:
    """Fill an agent turn's empty model pick from the caller's engine.

    Args:
        job_store: Job store whose ORM engine holds the setting, or ``None``.
        username: The caller.
        model: The request's raw ``model`` value.

    Returns:
        ``model`` unchanged when it names a model, in hosted mode, or when the
        engine is OpenRouter or unknown (in local mode the model router then
        runs the turn on the caller's verified OpenRouter key, or refuses it).
        Otherwise ``subscription/<cli>/<slug>`` on the engine
        CLI's first catalog model.
    """
    name = str(model or "").strip()
    if not settings.local_mode or parse_subscription_model_id(name) is not None:
        return model
    # The removed-model pattern is unanchored and also matches valid
    # subscription slugs, so it runs only after the subscription check.
    if name and name != _RETIRED_AUTO_ID and not is_removed_model(name):
        return model
    engine = effective_agent_engine(job_store, username)
    if engine is None or engine == OPENROUTER_ENGINE:
        return model
    cli: CliProvider = engine
    return f"subscription/{cli}/{next(iter(CLI_MODELS[cli]))}"
