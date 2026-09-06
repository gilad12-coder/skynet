"""Supervise the unchanged DSPy service through a parent-owned Vercel sandbox."""

from __future__ import annotations

import base64
import json
import re
import secrets
import shlex
from pathlib import Path
from typing import Any

from ..billing.runtime import UsagePendingError
from ..billing.signals import BudgetReached
from ..exceptions import InfrastructureInterruptionError
from ..service_gateway.optimization.blackbox.remote_sandbox import RemoteSandboxRuntime
from ..service_gateway.optimization.blackbox.sandbox import SandboxSpec
from .checkpoint_compat import runtime_identity
from .constants import EVENT_ERROR, EVENT_RESULT, EVENT_TERMINAL
from .failure_events import failure_event
from .isolated_runner import EVENT_PREFIX

CHECKPOINT_EVENT = "checkpoint_file"
_CHECKPOINT_PATH = re.compile(r"(?:(?:pair_\d+|gepa)/)?gepa_state\.bin\Z")


def _save_checkpoint(directory: Path, event: dict[str, Any]) -> None:
    """Mirror only recognized state files into the generation-owned checkpoint directory.

    Args:
        directory: Parent-owned checkpoint staging root.
        event: Guest frame containing a relative state path and base64 bytes.
    """
    path = event.get("path")
    if not isinstance(path, str) or not _CHECKPOINT_PATH.fullmatch(path):
        raise ValueError("The sandbox returned an invalid checkpoint path.")
    data = base64.b64decode(event["data"], validate=True)
    target = directory / path
    target.parent.mkdir(parents=True, exist_ok=True)
    temporary = target.with_suffix(".incoming")
    temporary.write_bytes(data)
    temporary.replace(target)


def run_vercel_dspy(payload: dict[str, Any], artifact_id: str, event_queue: Any, _start_method: str) -> None:
    """Execute the full optimizer in the pinned backend image without provider credentials.

    Args:
        payload: Resolved request carrying a scoped parent sandbox descriptor.
        artifact_id: Generation-specific result artifact namespace.
        event_queue: Worker event queue receiving original optimizer events.
        _start_method: Existing process target contract; the guest initializes fresh.
    """
    session = None
    try:
        guest_payload = dict(payload)
        if "_preflight" in guest_payload:
            guest_payload.pop("_gepa_log_dir", None)
        descriptor = guest_payload.pop("_budget_gateway_descriptor", None)
        if not isinstance(descriptor, dict):
            raise TypeError("The Vercel optimizer requires a trusted sandbox descriptor.")
        runtime = RemoteSandboxRuntime(descriptor["url"], descriptor["control_token"])
        lifetime = float(descriptor["lifetime_seconds"])
        nonce = secrets.token_hex(24)
        checkpoint_root = Path(guest_payload["_gepa_log_dir"]) if guest_payload.get("_gepa_log_dir") else None
        checkpoints = {}
        if checkpoint_root is not None:
            for path in checkpoint_root.rglob("gepa_state.bin"):
                relative = path.relative_to(checkpoint_root).as_posix()
                if _CHECKPOINT_PATH.fullmatch(relative):
                    checkpoints[relative] = base64.b64encode(path.read_bytes()).decode()
            guest_payload["_gepa_log_dir"] = "checkpoints"
        session = runtime.open(
            SandboxSpec(
                lifetime_seconds=lifetime,
                image=descriptor["image"],
                network_disabled=True,
                operation_key=f"dspy:{artifact_id}",
            )
        )
        document = {
            "payload": guest_payload,
            "artifact_id": artifact_id,
            "nonce": nonce,
            "checkpoints": checkpoints,
            "export_checkpoints": checkpoint_root is not None,
            "runtime_identity": runtime_identity(),
        }
        request_path = f".skynet-dspy-{nonce}/request.json"
        session.write_files({request_path: json.dumps(document)})
        pending = {"stdout": "", "stderr": ""}
        terminal = False
        prefix = f"{EVENT_PREFIX}{nonce} "

        def output(stream: str, text: str) -> None:
            """Forward optimizer events and atomically stage recovery checkpoints.

            Args:
                stream: Sandbox stdout or stderr channel.
                text: The next command output chunk.
            """
            nonlocal terminal
            pending[stream] = pending.get(stream, "") + text
            while "\n" in pending[stream]:
                line, pending[stream] = pending[stream].split("\n", 1)
                if not line.startswith(prefix):
                    continue
                event = json.loads(line[len(prefix) :])
                if not isinstance(event, dict):
                    raise TypeError("The sandbox returned an invalid optimizer event.")
                if event.get("type") == CHECKPOINT_EVENT:
                    if checkpoint_root is None:
                        raise ValueError("The sandbox returned an unrequested checkpoint.")
                    _save_checkpoint(checkpoint_root, event)
                else:
                    terminal = terminal or event.get("type") in {
                        EVENT_RESULT,
                        EVENT_TERMINAL,
                        EVENT_ERROR,
                        "preflight_result",
                        "interaction_result",
                    }
                    event_queue.put(event)

        command = f"PYTHONPATH=/app python3 -m core.worker.isolated_runner {shlex.quote(request_path)}"
        if "_preflight" in guest_payload:
            event_queue.put({"type": "preflight_phase", "phase": "evaluator"})
        result = session.run(
            command,
            env={"PYTHONUNBUFFERED": "1", "LITELLM_LOCAL_MODEL_COST_MAP": "True"},
            timeout_seconds=lifetime,
            on_output=output,
        )
        if not terminal or not result.ok:
            raise InfrastructureInterruptionError(
                f"The Vercel optimizer exited without a complete result (exit {result.exit_code})."
            )
    except BudgetReached as error:
        event_queue.put(
            {
                "type": EVENT_TERMINAL,
                "outcome": {
                    "status": "stopped",
                    "stop_reason": "budget_reached",
                    "result_availability": "none",
                    "result": None,
                    "message": str(error),
                    "evidence": {
                        "candidate_origin": None,
                        "final_evaluation_completed": False,
                        "final_evaluation_reason": "budget_reached",
                    },
                },
            }
        )
    except Exception as error:
        event_queue.put(failure_event(error))
    finally:
        if session is not None:
            try:
                session.close()
            except UsagePendingError:
                pass
            except Exception as error:
                event_queue.put(failure_event(error))
