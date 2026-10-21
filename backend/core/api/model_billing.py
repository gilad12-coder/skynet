"""Canonicalize per-model billing sources before setup or submission."""

from __future__ import annotations

from ..constants import TOKEN_SOURCE_BYOK, TOKEN_SOURCE_MANAGED, TOKEN_SOURCE_SUBSCRIPTION
from ..models import BlackboxRunRequest, RunRequest, UnifiedRunRequest
from ..models.common import ModelConfig
from ..models.submissions import _OptimizationRequestBase
from .errors import DomainError


def request_model_configs(
    payload: _OptimizationRequestBase | BlackboxRunRequest | UnifiedRunRequest,
) -> list[ModelConfig]:
    """Return every executable model config carried by a submission.

    Args:
        payload: Run, Anything, or unified request.

    Returns:
        Model configs in execution order.
    """
    if isinstance(payload, BlackboxRunRequest):
        return [
            config
            for config in (
                payload.task_model_settings,
                payload.reflection_model_settings,
                *payload.extra_reflection_model_settings,
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
    if isinstance(payload, UnifiedRunRequest):
        models = payload.models
        return [
            config
            for config in (
                models.task_model,
                models.reflection_model,
                *models.extra_reflection_models,
                models.metric_model,
            )
            if config is not None
        ]
    return []


def normalize_model_token_sources(
    payload: _OptimizationRequestBase | BlackboxRunRequest | UnifiedRunRequest,
) -> tuple[list[ModelConfig], dict[str, str]]:
    """Resolve legacy job-level sources into explicit per-model sources.

    The run-level source becomes ``byok`` or ``subscription`` when every model
    uses it, and ``managed`` otherwise.

    Args:
        payload: Run, Anything, or unified request to normalize in place.

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
    payload.token_source = TOKEN_SOURCE_MANAGED
    for uniform in (TOKEN_SOURCE_BYOK, TOKEN_SOURCE_SUBSCRIPTION):
        if sources and all(source == uniform for source in sources.values()):
            payload.token_source = uniform
    return configs, sources
