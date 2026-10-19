"""Resolve paid-submission replay identities without exposing request secrets."""

from __future__ import annotations

from dataclasses import dataclass

from pydantic import BaseModel

from ..billing.operation_pricing import json_fingerprint

_LEGACY_CONTRACT = 1
_LEGACY_PREFIX = "legacy-paid-v1:"


@dataclass(frozen=True)
class SubmissionReplayKeys:
    """Carry the job lookup key and budget creation key for one request."""

    job: str | None
    budget: str | None
    synthesized: bool = False


def explicit_budget_key(workflow: str, key: str) -> str:
    """Return the budget creation key of a submission sent with an explicit idempotency key.

    Args:
        workflow: DSPy or Anything request family.
        key: The caller's non-blank ``Idempotency-Key``.

    Returns:
        The budget creation key.
    """
    return "api:" + json_fingerprint({"workflow": workflow, "key": key})


def resolve_submission_replay_keys(
    payload: BaseModel,
    *,
    username: str,
    workflow: str,
    supplied_key: str | None,
) -> SubmissionReplayKeys:
    """Resolve explicit, modern, or synthesized paid-submission replay keys.

    A budgetless older client cannot tell the server whether a repeated request
    is intentional or an uncertain transport retry. Its typed request therefore
    receives a content-addressed identity. Semantically identical legacy
    requests replay the first accepted job until the caller supplies an explicit
    key or changes an input. Only the digest is returned; raw credentials and
    authored payload content never enter the key or logs.

    Args:
        payload: Typed request before budget, setup evidence, or seed mutation.
        username: Authenticated account owning the request and replay scope.
        workflow: DSPy or Anything request family.
        supplied_key: Optional caller-provided ``Idempotency-Key`` header.

    Returns:
        Keys for account-scoped job lookup/persistence and budget creation.
    """
    explicit = (supplied_key or "").strip() or None
    if explicit is not None:
        return SubmissionReplayKeys(job=explicit, budget=explicit_budget_key(workflow, explicit))
    if getattr(payload, "execution_budget_id", None) is not None:
        return SubmissionReplayKeys(job=None, budget=None)
    request_fingerprint = json_fingerprint(payload.model_dump(mode="json", by_alias=True))
    synthesized = _LEGACY_PREFIX + json_fingerprint(
        {
            "contract": _LEGACY_CONTRACT,
            "username": username,
            "workflow": workflow,
            "request_fingerprint": request_fingerprint,
        }
    )
    return SubmissionReplayKeys(job=synthesized, budget=synthesized, synthesized=True)
