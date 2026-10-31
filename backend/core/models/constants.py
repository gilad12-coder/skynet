"""Cross-file constants for the Pydantic model layer.

``HEALTH_STATUS_OK`` is the literal string the ``/health`` endpoint
returns when the service is ready. Both the model default
(:class:`~core.models.infra.HealthResponse`) and the endpoint
implementation in :mod:`core.api.app` reference it, so extracting it
keeps both ends in lockstep without forcing a circular import.
"""

from __future__ import annotations

HEALTH_STATUS_OK = "ok"

# Droid was removed because it cannot run isolated from the user's own hooks,
# MCP servers, config and rules (SKY-144). Saved settings and stored runs can
# still name it, so they fail with this message instead of a bare enum error.
REMOVED_CLI_PROVIDER = "droid"
REMOVED_CLI_PROVIDER_MESSAGE = "Droid is no longer supported. Choose codex or claude."
