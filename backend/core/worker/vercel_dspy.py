"""Supervise the unchanged DSPy service through a parent-owned Vercel sandbox."""

from __future__ import annotations

import base64
import io
import json
import logging
import re
import secrets
import shlex
import tarfile
from pathlib import Path
from typing import Any

from ..billing.runtime import UsagePendingError
from ..billing.signals import BudgetReached
from ..exceptions import InfrastructureInterruptionError
from ..i18n import CATALOG_PATH
from ..service_gateway.optimization.blackbox.remote_sandbox import RemoteSandboxRuntime
from ..service_gateway.optimization.blackbox.sandbox import CommandResult, SandboxSpec
from .checkpoint_compat import runtime_identity, source_files
from .constants import EVENT_ERROR, EVENT_RESULT, EVENT_TERMINAL
from .failure_events import failure_event
from .isolated_runner import EVENT_PREFIX, INCOMPATIBLE_IMAGE_MESSAGE

logger = logging.getLogger(__name__)

CHECKPOINT_EVENT = "checkpoint_file"
_CHECKPOINT_PATH = re.compile(r"(?:(?:pair_\d+|gepa)/)?gepa_state\.bin\Z")
_MISSING_CORE_MODULE = re.compile(r"(?:ModuleNotFoundError|ImportError): .*\bcore\.")
_DIAGNOSTIC_LINES = 40


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


def _source_archive() -> str:
    """Pack the worker's backend package for its guest.

    The image pins Python and the optimizer dependencies, while the backend
    modules come from the worker itself, so the guest always runs the revision
    that supervises it and the identity check no longer demands a rebuilt image
    after every backend change.

    Returns:
        Base64 gzip tar of the modules the runtime identity covers, plus the
        locale catalog the package reads lazily.
    """
    entries = list(source_files())
    if Path(CATALOG_PATH).is_file():
        entries.append(("i18n_locales/he.json", Path(CATALOG_PATH)))
    buffer = io.BytesIO()
    with tarfile.open(fileobj=buffer, mode="w:gz") as archive:
        for relative, path in entries:
            data = path.read_bytes()
            member = tarfile.TarInfo(f"core/{relative}")
            member.size = len(data)
            member.mode = 0o644
            archive.addfile(member, io.BytesIO(data))
    return base64.b64encode(buffer.getvalue()).decode()


def _guest_failure(result: CommandResult) -> Exception:
    """Explain a guest that exited without a terminal event from its own stderr.

    The guest frames every failure inside its entrypoint as an event, so a bare
    non-zero exit means Python died before reaching it and the traceback on
    stderr is the only evidence. A ``core`` module failing to import there
    means the guest ran the image's own copy of the backend, built from another
    revision than this worker, instead of the source the worker ships.

    Args:
        result: Outcome of the guest command.

    Returns:
        The exception to raise, ending with the guest's last stderr line.
    """
    lines = [line.rstrip() for line in result.stderr.splitlines() if line.strip()]
    if lines:
        logger.error(
            "Vercel optimizer guest exited %s without a result:\n%s",
            result.exit_code,
            "\n".join(lines[-_DIAGNOSTIC_LINES:]),
        )
    last = lines[-1].strip() if lines and not result.timed_out else ""
    if _MISSING_CORE_MODULE.match(last):
        return RuntimeError(f"{INCOMPATIBLE_IMAGE_MESSAGE} {last}")
    detail = f" {last}" if last else ""
    return InfrastructureInterruptionError(
        f"The Vercel optimizer exited without a complete result (exit {result.exit_code}).{detail}"
    )


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
        session_root = f".skynet-dspy-{nonce}"
        request_path = f"{session_root}/request.json"
        archive_path = f"{session_root}/source.tgz.b64"
        source_root = f"{session_root}/source"
        session.write_files({request_path: json.dumps(document), archive_path: _source_archive()})
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

        # python -m puts the working directory ahead of PYTHONPATH, and the box
        # works in /app, where the image's own copy of the package lives; the
        # safe path keeps the shipped source first.
        command = (
            f"mkdir -p {shlex.quote(source_root)}"
            f" && base64 -d {shlex.quote(archive_path)} | tar -xzf - -C {shlex.quote(source_root)}"
            f' && PYTHONSAFEPATH=1 PYTHONPATH="$PWD"/{shlex.quote(source_root)}:/app'
            f" python3 -m core.worker.isolated_runner {shlex.quote(request_path)}"
        )
        if "_preflight" in guest_payload:
            event_queue.put({"type": "preflight_phase", "phase": "evaluator"})
        result = session.run(
            command,
            env={"PYTHONUNBUFFERED": "1", "LITELLM_LOCAL_MODEL_COST_MAP": "True"},
            timeout_seconds=lifetime,
            on_output=output,
        )
        if not terminal or not result.ok:
            raise _guest_failure(result)
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
