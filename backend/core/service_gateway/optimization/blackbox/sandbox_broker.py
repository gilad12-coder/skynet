"""Keep Vercel credentials and usage authority in the trusted worker parent."""

from __future__ import annotations

import math
import threading
import uuid
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import PurePosixPath
from typing import Any, Protocol

from ....billing.vercel_usage import quote_vercel_sandbox
from ....exceptions import ServiceError
from .sandbox import CommandResult, OutputSink, SandboxRuntime, SandboxSession, SandboxSpec

_MAX_FILE_BYTES = 16 * 1024 * 1024


class SandboxCommandRunner(Protocol):
    """Interpose the parent's model mailbox on one guest command."""

    def __call__(
        self,
        session: SandboxSession,
        command: str,
        *,
        env: Mapping[str, str] | None,
        timeout_seconds: float | None,
        on_output: OutputSink | None,
    ) -> CommandResult:
        """Execute through the trusted parent's model transport.

        Args:
            session: One owned sandbox without guest access to provider credentials.
            command: Guest shell command.
            env: Requested guest environment.
            timeout_seconds: Command deadline within the sandbox lifetime.
            on_output: Consumer for non-protocol output after model interception.

        Returns:
            Guest command outcome.
        """
        ...


@dataclass(frozen=True)
class _OwnedSession:
    """Associate an opaque capability with one fixed resource envelope."""

    session: SandboxSession
    lifetime_seconds: float


def _duration(value: Any, maximum: float) -> float:
    """Reject a client duration that exceeds the parent's funded profile.

    Args:
        value: Requested duration in seconds.
        maximum: Parent-controlled maximum in seconds.

    Returns:
        Finite positive duration within the authorized profile.
    """
    if (
        isinstance(value, bool)
        or not isinstance(value, int | float)
        or not math.isfinite(value)
        or not 0 < value <= maximum
    ):
        raise ServiceError("Sandbox duration exceeds the trusted runtime profile.")
    return float(value)


def _environment(value: Any) -> dict[str, str]:
    """Validate a guest environment without accepting provider control parameters.

    Args:
        value: Optional JSON string mapping.

    Returns:
        A detached mapping of guest environment values.
    """
    if value is None:
        return {}
    if not isinstance(value, dict) or any(
        not isinstance(key, str) or not isinstance(item, str) for key, item in value.items()
    ):
        raise ServiceError("Sandbox environment must contain string keys and values.")
    return dict(value)


def _relative_path(value: Any) -> str:
    """Keep file actions inside the guest work directory.

    Args:
        value: Client file path, never a parent filesystem path.

    Returns:
        A normalized relative POSIX path.
    """
    if not isinstance(value, str) or not value or "\x00" in value:
        raise ServiceError("Sandbox file path must be a nonempty relative path.")
    path = PurePosixPath(value)
    if path.is_absolute() or ".." in path.parts:
        raise ServiceError("Sandbox file path must stay inside its working directory.")
    return str(path)


class SandboxBroker:
    """Expose only owned guest operations while retaining credentials and billing."""

    def __init__(
        self,
        runtime: SandboxRuntime,
        *,
        image: str,
        max_lifetime_seconds: float,
        vcpus: int = 2,
        tags: Mapping[str, str] | None = None,
        command_runner: SandboxCommandRunner | None = None,
    ) -> None:
        """Bind one parent-owned runtime and deployment-selected resource profile.

        Args:
            runtime: Metered Vercel runtime held only in the trusted parent.
            image: Deployment-selected immutable prebuilt image digest.
            max_lifetime_seconds: Largest session the parent will authorize.
            vcpus: Fixed allocation selected by the parent.
            tags: Parent-owned job identity used by cleanup and reconciliation.
            command_runner: Optional model mailbox command wrapper.
        """
        self._runtime = runtime
        self._image = image
        self._maximum = _duration(max_lifetime_seconds, 86_400)
        quote_vercel_sandbox(
            {
                "image": image,
                "lifetime_ms": math.ceil(self._maximum * 1000),
                "vcpus": vcpus,
                "network_disabled": True,
                "ports": [],
                "persistent": False,
            }
        )
        self._vcpus = vcpus
        self._tags = dict(tags or {})
        self._command_runner = command_runner
        self._sessions: dict[str, _OwnedSession] = {}
        self._opened: dict[str, tuple[dict[str, Any], str]] = {}
        self._opening: set[str] = set()
        self._lock = threading.Lock()
        self._closed = False

    def _owned(self, payload: Mapping[str, Any]) -> _OwnedSession:
        """Resolve an opaque capability only within this authenticated broker.

        Args:
            payload: Action parameters containing a sandbox_id.

        Returns:
            The owned session and its funded lifetime.
        """
        identity = payload.get("sandbox_id")
        with self._lock:
            owned = self._sessions.get(identity) if isinstance(identity, str) else None
        if owned is None:
            raise ServiceError("Sandbox handle is closed or does not belong to this run.")
        return owned

    def _open(self, payload: Mapping[str, Any]) -> dict[str, Any]:
        """Create a sandbox using the parent's fixed image, network, and resource profile.

        Args:
            payload: Stable request_id and a requested guest spec.

        Returns:
            An opaque sandbox handle without provider identities or credentials.
        """
        request_id = payload.get("request_id")
        spec = payload.get("spec")
        if not isinstance(request_id, str) or not request_id or len(request_id) > 100 or not isinstance(spec, dict):
            raise ServiceError("Sandbox creation requires a stable request identity and spec.")
        lifetime = _duration(spec.get("lifetime_seconds"), self._maximum)
        if (spec.get("image") is not None and spec.get("image") != self._image) or spec.get(
            "vcpus", self._vcpus
        ) != self._vcpus:
            raise ServiceError("The child cannot override the trusted sandbox image or resource profile.")
        if spec.get("inject_headers"):
            raise ServiceError("Protected sandbox model calls use the parent mailbox.")
        requested = {"lifetime_seconds": lifetime, "env": _environment(spec.get("env"))}
        with self._lock:
            if self._closed:
                raise ServiceError("The sandbox broker is closed.")
            prior = self._opened.get(request_id)
            if prior is not None:
                if prior[0] != requested:
                    raise ServiceError("Sandbox request identity was reused with a different spec.")
                if prior[1] not in self._sessions:
                    raise ServiceError("The sandbox for this request was already closed.")
                return {"sandbox_id": prior[1]}
            if request_id in self._opening:
                raise ServiceError("This sandbox creation is already in progress.")
            self._opening.add(request_id)
        try:
            session = self._runtime.open(
                SandboxSpec(
                    lifetime_seconds=lifetime,
                    env=requested["env"],
                    image=self._image,
                    vcpus=self._vcpus,
                    tags=self._tags,
                    network_disabled=True,
                    operation_key=f"sandbox:{request_id}",
                )
            )
            identity = uuid.uuid4().hex
            with self._lock:
                closing = self._closed
                if not closing:
                    self._sessions[identity] = _OwnedSession(session, lifetime)
                    self._opened[request_id] = (requested, identity)
            if closing:
                session.close()
                raise ServiceError("The sandbox broker closed during creation.")
            return {"sandbox_id": identity}
        finally:
            with self._lock:
                self._opening.discard(request_id)

    def handle(self, action: str, payload: Mapping[str, Any]) -> dict[str, Any]:
        """Perform one non-streaming action inside an owned guest sandbox.

        Args:
            action: Open, write, read, or close.
            payload: JSON action parameters from the separately authenticated control route.

        Returns:
            JSON guest data, excluding credentials, provider metadata, and settlement state.
        """
        if action == "open":
            return self._open(payload)
        owned = self._owned(payload)
        if action == "write":
            raw = payload.get("files")
            if not isinstance(raw, dict) or any(not isinstance(content, str) for content in raw.values()):
                raise ServiceError("Sandbox writes require text files.")
            files = {_relative_path(path): content for path, content in raw.items()}
            if sum(len(content.encode()) for content in files.values()) > _MAX_FILE_BYTES:
                raise ServiceError("Sandbox file upload exceeds the per-request limit.")
            owned.session.write_files(files)
            return {}
        if action == "read":
            content = owned.session.read_file(_relative_path(payload.get("path")))
            if content is not None and len(content.encode()) > _MAX_FILE_BYTES:
                raise ServiceError("Sandbox file exceeds the per-response limit.")
            return {"content": content}
        if action == "close":
            with self._lock:
                self._sessions.pop(payload["sandbox_id"], None)
            owned.session.close()
            return {}
        raise ServiceError("Unsupported sandbox control action.")

    def run(self, payload: Mapping[str, Any], on_output: OutputSink | None = None) -> CommandResult:
        """Stream a guest command through the optional trusted model mailbox.

        Args:
            payload: Owned sandbox handle, command, environment, and optional timeout.
            on_output: Consumer for guest output after parent-side interception.

        Returns:
            The final command outcome for the NDJSON terminal frame.
        """
        owned = self._owned(payload)
        command = payload.get("command")
        if not isinstance(command, str) or not command:
            raise ServiceError("Sandbox commands must be nonempty strings.")
        timeout = payload.get("timeout_seconds")
        timeout = owned.lifetime_seconds if timeout is None else _duration(timeout, owned.lifetime_seconds)
        options = {"env": _environment(payload.get("env")), "timeout_seconds": timeout, "on_output": on_output}
        if self._command_runner is not None:
            return self._command_runner(owned.session, command, **options)
        return owned.session.run(command, **options)

    def close(self) -> None:
        """Stop every owned sandbox, preserving any failed settlement for reconciliation.

        Raises:
            BaseException: The first cleanup failure, after every owned session is closed.
        """
        with self._lock:
            self._closed = True
            owned = tuple(self._sessions.values())
            self._sessions.clear()
        failure: BaseException | None = None
        for item in owned:
            try:
                item.session.close()
            except BaseException as error:
                failure = failure or error
        if failure is not None:
            raise failure
