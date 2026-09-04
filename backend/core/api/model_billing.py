"""Canonicalize per-model billing sources before setup or submission."""

from __future__ import annotations

from ..constants import TOKEN_SOURCE_BYOK, TOKEN_SOURCE_MANAGED
from ..models import BlackboxRunRequest, GridSearchRequest, RunRequest
from ..models.common import ModelConfig
from ..models.submissions import _OptimizationRequestBase
from .errors import DomainError


def request_model_configs(payload: _OptimizationRequestBase | BlackboxRunRequest) -> list[ModelConfig]:
    """Return every executable model config carried by a submission.

    Args:
        payload: Run, grid, or Anything request.

    Returns:
        Model configs in execution order.
    """
    if isinstance(payload, BlackboxRunRequest):
        return [
            config
            for config in (
                payload.task_model_settings,
                payload.reflection_model_settings,
                payload.scorer.model,
            )
            if config is not None
        ]
    if isinstance(payload, RunRequest):
        return [
            config
            for config in (
                payload.model_settings,
                payload.reflection_model_settings,
                payload.task_model_settings,
            )
            if config is not None
        ]
    if isinstance(payload, GridSearchRequest):
        return [*payload.generation_models, *payload.reflection_models]
    return []


def normalize_model_token_sources(
    payload: _OptimizationRequestBase | BlackboxRunRequest,
) -> tuple[list[ModelConfig], dict[str, str]]:
    """Resolve legacy job-level sources into explicit per-model sources.

    Args:
        payload: Run, grid, or Anything request to normalize in place.

    Returns:
        The model configs and their normalized model-to-source billing map.

    Raises:
        DomainError: When one model id is assigned conflicting sources.
    """
    configs = request_model_configs(payload)
    sources: dict[str, str] = {}
    for config in configs:
        source = config.token_source or payload.token_source
        config.token_source = source
        config.base_url = None
        for field in ("api_key", "api_base", "base_url"):
            config.extra.pop(field, None)
        if source == TOKEN_SOURCE_MANAGED:
            config.byok_provider = None
        model = config.normalized_identifier()
        existing = sources.get(model)
        if existing is not None and existing != source:
            raise DomainError("submission.validation_failed", status=400)
        sources[model] = source
    payload.token_source = (
        TOKEN_SOURCE_BYOK
        if sources and all(source == TOKEN_SOURCE_BYOK for source in sources.values())
        else TOKEN_SOURCE_MANAGED
    )
    return configs, sources
