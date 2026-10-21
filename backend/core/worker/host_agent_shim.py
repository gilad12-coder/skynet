"""Guest side of a host-CLI proposer turn: ship the workspace out, apply the result.

In local mode a proposer can run on the user's own coding CLI (Codex, Claude
Code or Droid) instead of inside the sandbox. This shim is the proposer
command the sandbox runs. It packs the current workspace, sends it to the
parent's ``/v1/_host_agent`` capability with its route token, and writes the
tree that comes back over the workspace. The parent runs the CLI in a copy,
never in the user's own folder.

The sandbox image may not have the backend on its import path, so the
launch ships this file's source and runs it with ``python3``. It therefore
imports only the standard library. ``python -m core.worker.host_agent_shim``
runs the same code.
"""

from __future__ import annotations

import base64
import io
import json
import os
import sys
import tarfile
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

CAPABILITY_PATH = "/v1/_host_agent"
# The guest relay and the parent gateway both refuse larger request bodies.
MAX_REQUEST_BYTES = 32 * 1024 * 1024
# Launch-generated config (this shim included) and bridge session state stay
# in the sandbox; the host CLI never needs them.
EXCLUDED_TOP_LEVEL = frozenset({".app", ".app-bridge"})
RATE_LIMITED_CODE = "subscription.rate_limited"
FAILURE_PREFIX = "APP_HOST_AGENT_ERROR "
_TIMEOUT_MARGIN_SECONDS = 120.0


def _env(name: str, default: str = "") -> str:
    """Read an ``APP_*`` variable, falling back to its ``SKYNET_*`` spelling.

    Args:
        name: Variable name with the ``APP_`` prefix.

    Returns:
        The value, or ``default`` when neither spelling is set.
    """
    return os.environ.get(name) or os.environ.get("SKYNET_" + name.removeprefix("APP_")) or default


def endpoint_url() -> str:
    """Return the capability URL behind the sandbox relay or the gateway.

    Returns:
        The absolute ``/v1/_host_agent`` URL.

    Raises:
        RuntimeError: When neither a relay nor a gateway URL is set.
    """
    base = _env("APP_BUDGET_RELAY_URL") or _env("APP_GATEWAY_URL")
    if not base:
        raise RuntimeError("No model gateway is configured for the host agent.")
    return base.rstrip("/").removesuffix("/v1") + CAPABILITY_PATH


def _excluded(relative: Path) -> bool:
    """Tell whether a workspace path stays out of the shipped archive.

    Args:
        relative: Path relative to the workspace root.

    Returns:
        True for launch config and bridge state.
    """
    return bool(relative.parts) and relative.parts[0] in EXCLUDED_TOP_LEVEL


def pack_workspace(workspace: Path) -> tuple[bytes, set[str]]:
    """Archive the workspace as gzip tar, without following links.

    Args:
        workspace: Directory the proposer works in.

    Returns:
        The archive bytes and the relative paths of the regular files in it.
    """
    buffer = io.BytesIO()
    files: set[str] = set()
    with tarfile.open(fileobj=buffer, mode="w:gz") as archive:
        for path in sorted(workspace.rglob("*")):
            relative = path.relative_to(workspace)
            if _excluded(relative):
                continue
            archive.add(path, arcname=relative.as_posix(), recursive=False)
            if path.is_file() and not path.is_symlink():
                files.add(relative.as_posix())
    return buffer.getvalue(), files


def apply_result(workspace: Path, archive_bytes: bytes, shipped: set[str]) -> None:
    """Write the returned tree over the workspace, including deletions.

    Args:
        workspace: Directory the proposer works in.
        archive_bytes: Gzip tar of the edited copy.
        shipped: Regular files that were sent, so files the CLI deleted are removed here too.
    """
    with tarfile.open(fileobj=io.BytesIO(archive_bytes), mode="r:gz") as archive:
        members = archive.getmembers()
        returned = {member.name.removeprefix("./") for member in members}
        for relative in shipped - returned:
            (workspace / relative).unlink(missing_ok=True)
        for member in members:
            target = workspace / member.name
            # A file the CLI replaced with a link (or the reverse) must not
            # make extraction write through the old entry.
            if target.is_symlink() or (target.exists() and not target.is_dir() and member.isdir()):
                target.unlink()
        archive.extractall(workspace, filter="data")


def _post(url: str, token: str, body: bytes, timeout: float) -> tuple[int, dict[str, Any]]:
    """POST one JSON request and decode the JSON answer, error statuses included.

    Args:
        url: Capability URL.
        token: The proposer's route token.
        body: Encoded request.
        timeout: Socket timeout in seconds.

    Returns:
        HTTP status and decoded body (empty when the body is not JSON).
    """
    request = urllib.request.Request(
        url,
        data=body,
        method="POST",
        headers={"Content-Type": "application/json", "Authorization": f"Bearer {token}"},
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            status, raw = response.status, response.read()
    except urllib.error.HTTPError as error:
        status, raw = error.code, error.read()
    try:
        document = json.loads(raw or b"{}")
    except ValueError:
        document = {}
    return status, document if isinstance(document, dict) else {}


def _fail(code: str, message: str, reset_at: str | None = None) -> int:
    """Report a failed turn on stderr in a form the parent and the user can read.

    Args:
        code: Stable failure key.
        message: Human-readable detail.
        reset_at: When a usage cap ends, if known.

    Returns:
        The shim's exit status.
    """
    detail = {"code": code, "message": message, "reset_at": reset_at}
    print(FAILURE_PREFIX + json.dumps(detail), file=sys.stderr, flush=True)
    return 3 if code == RATE_LIMITED_CODE else 2


def main() -> int:
    """Run one host-CLI proposer turn for the current workspace.

    Returns:
        0 when the edited tree was applied, otherwise a non-zero status.
    """
    workspace = Path.cwd()
    prompt_file = _env("APP_PROMPT_FILE")
    prompt = Path(prompt_file).read_text(encoding="utf-8") if prompt_file else ""
    archive, shipped = pack_workspace(workspace)
    body = json.dumps(
        {
            "cli": _env("APP_HOST_CLI"),
            "model": _env("APP_MODEL"),
            "prompt": prompt,
            "permission": _env("APP_HOST_PERMISSION", "workspace_only"),
            "workspace_tar_b64": base64.b64encode(archive).decode("ascii"),
        }
    ).encode()
    if len(body) > MAX_REQUEST_BYTES:
        return _fail(
            "blackbox.host_agent_failed",
            f"The workspace is too large for a host agent turn ({len(body)} bytes, limit {MAX_REQUEST_BYTES}).",
        )
    timeout = float(_env("APP_HOST_AGENT_TIMEOUT", "3600")) + _TIMEOUT_MARGIN_SECONDS
    try:
        status, document = _post(endpoint_url(), _env("APP_API_KEY"), body, timeout)
    except (OSError, RuntimeError) as error:
        return _fail("blackbox.host_agent_failed", f"The host agent could not be reached: {error}")
    error = document.get("error") if isinstance(document.get("error"), dict) else {}
    if status != 200 or document.get("status") != "ok":
        code = str(error.get("code") or "blackbox.host_agent_failed")
        message = str(error.get("message") or document.get("transcript_tail") or f"HTTP {status}")
        return _fail(code, message, error.get("reset_at"))
    apply_result(workspace, base64.b64decode(document["result_tar_b64"]), shipped)
    usage = document.get("usage") or {}
    print(
        json.dumps(
            {
                "type": "host_agent.result",
                "text": str(document.get("transcript_tail") or ""),
                "usage": {
                    "input_tokens": int(usage.get("prompt_tokens") or 0),
                    "output_tokens": int(usage.get("completion_tokens") or 0),
                },
            }
        ),
        flush=True,
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
