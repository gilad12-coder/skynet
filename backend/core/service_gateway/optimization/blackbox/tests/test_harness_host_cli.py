"""Prove a host-CLI proposer launch: the shim ships the workspace out and applies the CLI's edits."""

from __future__ import annotations

import json
import os
import subprocess
import sys
from collections.abc import Iterator
from pathlib import Path

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import Session

from core.billing.budgets import BudgetService
from core.billing.host_agent import RATE_LIMITED_CODE, bind_host_agent
from core.billing.model_gateway import ModelGateway
from core.billing.runtime import BudgetRuntime
from core.config import Settings, settings
from core.exceptions import ServiceError
from core.models.blackbox import BLACKBOX_HARNESS_PI, BLACKBOX_TARGET_AGENT, BlackboxTarget
from core.storage.models import Base, BillingCustomerModel
from core.worker import scoped_relay

from .. import harness
from ..harness import HOST_AGENT_SHIM_FILE, GatewayConfig, build_launch, launch_payload
from ..harness_bridge import parse_host_agent_output

TARGET = BlackboxTarget(kind=BLACKBOX_TARGET_AGENT, harness=BLACKBOX_HARNESS_PI, model="target-model")
RESET_EPOCH = 1_893_456_000

# A fake Claude Code: edits the copy it runs in, or reports a usage cap.
FAKE_CLAUDE = """
import json, os, sys
from pathlib import Path

sys.stdin.read()
if os.environ.get("FAKE_CLI_MODE") == "limit":
    print(json.dumps({"type": "result", "subtype": "success", "is_error": True,
                      "result": "Claude AI usage limit reached|__EPOCH__"}))
    sys.exit(1)
Path("solver.py").write_text("def solve():\\n    return 2\\n")
Path("stale.txt").unlink()
Path("pkg").mkdir()
Path("pkg/helper.py").write_text("X = 1\\n")
print(json.dumps({"type": "result", "subtype": "success", "is_error": False, "result": "Raised the score.",
                  "duration_api_ms": 900, "usage": {"input_tokens": 40, "output_tokens": 7}}))
""".replace("__EPOCH__", str(RESET_EPOCH))


@pytest.fixture
def local(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Settings:
    """Turn local mode on for the launch and point Claude Code at the fake."""
    script = tmp_path / "fake-claude"
    script.write_text(f"#!{sys.executable}\n{FAKE_CLAUDE}")
    script.chmod(0o755)
    local_settings = settings.model_copy(
        update={
            "local_mode": True,
            "local_state_dir": str(tmp_path / "state"),
            "claude_bin": str(script),
            "host_agent_timeout_seconds": 60,
        }
    )
    monkeypatch.setattr(harness, "settings", local_settings)
    return local_settings


@pytest.fixture
def gateway(tmp_path: Path, local: Settings) -> Iterator[tuple[ModelGateway, str]]:
    """A real parent gateway with the capability bound and one proposer token."""
    engine = create_engine(f"sqlite:///{tmp_path / 'host.db'}", connect_args={"check_same_thread": False})
    Base.metadata.create_all(engine)
    with Session(engine) as session:
        session.add(
            BillingCustomerModel(username="alice", stripe_customer_id="fixture", balance_cents=50, grant_remaining=0)
        )
        session.commit()
    ledger = BudgetService(engine=engine)
    budget = ledger.create("alice", 20, idempotency_key="fixture")
    gateway = ModelGateway(BudgetRuntime(ledger, username="alice", budget_id=budget.id, generation=0, phase="setup"))
    bind_host_agent(gateway, local)
    gateway._routes["proposer-token"] = object()  # type: ignore[assignment]
    yield gateway, "proposer-token"
    gateway._routes.clear()
    gateway.close()
    engine.dispose()


def _run_shim(workspace: Path, gateway: ModelGateway, token: str, **extra: str) -> subprocess.CompletedProcess[str]:
    """Run the launch's shim file in a guest workspace, as the sandbox bridge does.

    Args:
        workspace: Guest workspace that holds the launch files.
        gateway: Parent gateway the shim reaches.
        token: The proposer's route token.
        **extra: More environment variables.

    Returns:
        The finished shim process.
    """
    launch = build_launch(TARGET, GatewayConfig(url=gateway.url, api_key=token), host_cli="claude")
    for relative, text in launch.files.items():
        (workspace / relative).parent.mkdir(parents=True, exist_ok=True)
        (workspace / relative).write_text(text)
    prompt = workspace.parent / "prompt.md"
    prompt.write_text("Raise the score.")
    env = {
        "PATH": os.environ["PATH"],
        **launch.env,
        "APP_API_KEY": token,
        "APP_PROMPT_FILE": str(prompt),
        **extra,
    }
    return subprocess.run(
        ["bash", "-c", launch.run_command],
        cwd=workspace,
        env=env,
        capture_output=True,
        text=True,
        timeout=60,
        check=False,
    )


@pytest.fixture
def workspace(tmp_path: Path) -> Path:
    """A guest workspace with a file to edit and a file to delete."""
    root = tmp_path / "guest" / "work"
    root.mkdir(parents=True)
    (root / "solver.py").write_text("def solve():\n    return 1\n")
    (root / "stale.txt").write_text("old\n")
    return root


def test_host_launch_is_refused_outside_local_mode() -> None:
    """A hosted worker never builds a host-CLI launch."""
    with pytest.raises(ServiceError, match="Mac app"):
        build_launch(TARGET, GatewayConfig(url="https://gw.example/v1", api_key="k"), host_cli="claude")


@pytest.mark.parametrize(
    ("cli", "instructions"), [("codex", "AGENTS.md"), ("claude", "CLAUDE.md"), ("droid", "AGENTS.md")]
)
def test_host_launch_ships_only_the_shim(cli: str, instructions: str, local: Settings) -> None:
    """The launch installs nothing, runs the stdlib shim, and tells it the CLI and permission."""
    launch = build_launch(
        TARGET, GatewayConfig(url="https://gw.example/v1", api_key="k"), host_cli=cli, host_permission="full_access"
    )

    payload = launch_payload(launch)

    assert payload["install_command"] is None
    assert payload["instructions_file"] == instructions
    assert payload["output_format"] == "host_agent"
    assert HOST_AGENT_SHIM_FILE in payload["run_command"]
    assert set(payload["files"]) == {HOST_AGENT_SHIM_FILE}
    assert "import core" not in payload["files"][HOST_AGENT_SHIM_FILE]
    assert payload["env"]["APP_HOST_CLI"] == cli
    assert payload["env"]["APP_HOST_PERMISSION"] == "full_access"
    assert payload["env"]["APP_HOST_AGENT_TIMEOUT"] == "60"


def test_shim_applies_the_host_edit_to_the_guest_workspace(workspace: Path, gateway: tuple[ModelGateway, str]) -> None:
    """Edits, new files and deletions made by the host CLI appear in the guest workspace."""
    parent, token = gateway

    completed = _run_shim(workspace, parent, token)

    assert completed.returncode == 0, completed.stderr
    assert (workspace / "solver.py").read_text() == "def solve():\n    return 2\n"
    assert (workspace / "pkg" / "helper.py").read_text() == "X = 1\n"
    assert not (workspace / "stale.txt").exists()
    assert (workspace / HOST_AGENT_SHIM_FILE).exists()
    text, usage = parse_host_agent_output(completed.stdout)
    assert text == "Raised the score."
    assert usage == {"input_tokens": 40, "output_tokens": 7}


def test_shim_reports_a_usage_cap(
    workspace: Path, gateway: tuple[ModelGateway, str], monkeypatch: pytest.MonkeyPatch
) -> None:
    """A capped subscription leaves the workspace alone and reports the cap and reset time."""
    parent, token = gateway
    monkeypatch.setenv("FAKE_CLI_MODE", "limit")

    completed = _run_shim(workspace, parent, token)

    assert completed.returncode == 3
    line = next(row for row in completed.stderr.splitlines() if row.startswith("APP_HOST_AGENT_ERROR "))
    detail = json.loads(line.removeprefix("APP_HOST_AGENT_ERROR "))
    assert detail["code"] == RATE_LIMITED_CODE
    assert detail["reset_at"].startswith("2030-01-01")
    assert (workspace / "solver.py").read_text() == "def solve():\n    return 1\n"


def test_shim_refuses_a_workspace_over_the_cap(workspace: Path, gateway: tuple[ModelGateway, str]) -> None:
    """A workspace above 32 MB fails with blackbox.host_agent_failed and sends nothing."""
    parent, token = gateway
    (workspace / "blob.bin").write_bytes(os.urandom(33 * 1024 * 1024))

    completed = _run_shim(workspace, parent, token)

    assert completed.returncode == 2
    assert "blackbox.host_agent_failed" in completed.stderr
    assert "too large" in completed.stderr
    assert (workspace / "stale.txt").exists()


def test_relay_forwards_the_capability_with_the_host_timeout(monkeypatch: pytest.MonkeyPatch) -> None:
    """The sandbox relay allowlists /v1/_host_agent and waits for a whole host turn."""
    seen: dict[str, object] = {}

    class _Client:
        """Record the forwarded call instead of reaching a gateway."""

        def __init__(self, **kwargs: object) -> None:
            """Keep the client options."""
            seen.update(kwargs)

        def __enter__(self) -> _Client:
            """Open the fake client."""
            return self

        def __exit__(self, *args: object) -> None:
            """Close the fake client."""

        def request(self, method: str, url: str, **kwargs: object) -> object:
            """Answer the forwarded request.

            Args:
                method: HTTP method.
                url: Target URL.
                **kwargs: Request options.

            Returns:
                A minimal response.
            """
            seen["url"] = url

            class _Response:
                status_code = 200
                headers = {"content-type": "application/json"}
                content = b"{}"

            return _Response()

    monkeypatch.setattr(scoped_relay.httpx, "Client", _Client)
    monkeypatch.setattr(scoped_relay, "settings", settings.model_copy(update={"host_agent_timeout_seconds": 5000}))
    forward = scoped_relay.model_forwarder(
        {"model_config": {"extra": {"_skynet_budget_route": {"url": "http://127.0.0.1:9/v1", "token": "tok"}}}}
    )

    forward("tok", "/v1/_host_agent", {"cli": "claude"}, {})

    assert seen["url"] == "http://127.0.0.1:9/v1/_host_agent"
    assert seen["timeout"] == 5030
