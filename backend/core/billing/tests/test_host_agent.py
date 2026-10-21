"""Prove host-CLI proposer turns run on a copy, with stripped keys, under the run's budget."""

from __future__ import annotations

import base64
import io
import json
import sys
import tarfile
from collections.abc import Iterator
from datetime import UTC, datetime
from pathlib import Path

import httpx
import pytest
from sqlalchemy import Engine, create_engine, select
from sqlalchemy.orm import Session

from core.billing import host_agent
from core.billing.budgets import BudgetService
from core.billing.host_agent import (
    HOST_AGENT_PATH,
    RATE_LIMITED_CODE,
    bind_host_agent,
    failure_message,
    host_agent_failure,
    host_cli_argv,
    run_host_agent,
)
from core.billing.model_gateway import ModelGateway
from core.billing.operation_pricing import UnpricedOperationError
from core.billing.runtime import BudgetRuntime
from core.config import Settings, settings
from core.local.cli_probe import read_cli_limits
from core.storage.models import Base, BillingCustomerModel, ExecutionOperationModel

STRIPPED = ("ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "OPENAI_API_KEY")
RESET_EPOCH = 1_893_456_000

# One fake for all three CLIs: it records how it was started, edits the copy,
# and prints that CLI's JSON shape (shapes taken from real codex/claude/droid runs).
FAKE_CLI = r"""
import json, os, sys
from pathlib import Path

cli = os.environ["FAKE_CLI_NAME"]
argv = sys.argv[1:]
prompt = sys.stdin.read()
if "-f" in argv:
    prompt = Path(argv[argv.index("-f") + 1]).read_text()
Path(os.environ["FAKE_CLI_RECORD"]).write_text(json.dumps({
    "argv": argv,
    "cwd": os.getcwd(),
    "env": {key: os.environ.get(key) for key in __STRIPPED__},
    "prompt": prompt,
}))
if os.environ.get("FAKE_CLI_MODE") == "limit":
    if cli == "claude":
        print(json.dumps({"type": "result", "subtype": "success", "is_error": True,
                          "result": "Claude AI usage limit reached|__EPOCH__"}))
    else:
        print("You've hit your usage limit. Try again later.", file=sys.stderr)
    sys.exit(1)
target = Path("solver.py")
target.write_text(target.read_text() + "# improved\n")
Path("stale.txt").unlink()
Path("notes").mkdir()
Path("notes/plan.md").write_text("plan\n")
if cli == "codex":
    print(json.dumps({"type": "thread.started", "thread_id": "t"}))
    print(json.dumps({"type": "item.completed", "item": {"id": "i0", "type": "error", "message": "warning"}}))
    print(json.dumps({"type": "item.completed", "item": {"id": "i1", "type": "agent_message", "text": "done"}}))
    print(json.dumps({"type": "turn.completed", "usage": {"input_tokens": 120, "output_tokens": 30}}))
else:
    print(json.dumps({"type": "result", "subtype": "success", "is_error": False, "result": "done",
                      "duration_api_ms": 1500, "usage": {"input_tokens": 100, "cache_read_input_tokens": 20,
                                                         "output_tokens": 30}}))
""".replace("__STRIPPED__", repr(STRIPPED)).replace("__EPOCH__", str(RESET_EPOCH))


def _fake_cli(directory: Path) -> Path:
    """Write the fake CLI as an executable script.

    Args:
        directory: Where to put it.

    Returns:
        The script path.
    """
    script = directory / "fake-cli"
    script.write_text(f"#!{sys.executable}\n{FAKE_CLI}")
    script.chmod(0o755)
    return script


def _workspace_tar(root: Path) -> str:
    """Pack a guest workspace the way the shim does.

    Args:
        root: Workspace directory.

    Returns:
        Base64 gzip tar.
    """
    buffer = io.BytesIO()
    with tarfile.open(fileobj=buffer, mode="w:gz") as archive:
        for path in sorted(root.rglob("*")):
            archive.add(path, arcname=path.relative_to(root).as_posix(), recursive=False)
    return base64.b64encode(buffer.getvalue()).decode()


def _members(result_b64: str) -> dict[str, str]:
    """Read the regular files of a returned tree.

    Args:
        result_b64: Base64 gzip tar from the parent.

    Returns:
        Relative path to text content.
    """
    with tarfile.open(fileobj=io.BytesIO(base64.b64decode(result_b64)), mode="r:gz") as archive:
        return {
            member.name: archive.extractfile(member).read().decode()  # type: ignore[union-attr]
            for member in archive.getmembers()
            if member.isfile()
        }


@pytest.fixture
def local(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Settings:
    """Local-mode settings whose CLIs are the fake, with provider keys in the parent env."""
    script = _fake_cli(tmp_path)
    for key in STRIPPED:
        monkeypatch.setenv(key, "parent-only-value")
    monkeypatch.setenv("FAKE_CLI_RECORD", str(tmp_path / "record.json"))
    return settings.model_copy(
        update={
            "local_mode": True,
            "local_state_dir": str(tmp_path / "state"),
            "codex_bin": str(script),
            "claude_bin": str(script),
            "droid_bin": str(script),
            "host_agent_timeout_seconds": 60,
        }
    )


@pytest.fixture
def guest(tmp_path: Path) -> Path:
    """A guest workspace with one file to edit and one to delete."""
    root = tmp_path / "guest"
    root.mkdir()
    (root / "solver.py").write_text("def solve():\n    return 1\n")
    (root / "stale.txt").write_text("old\n")
    return root


@pytest.mark.parametrize(
    ("cli", "permission", "expected"),
    [
        ("codex", "workspace_only", ["exec", "--json", "--sandbox", "workspace-write", "--skip-git-repo-check", "-C"]),
        (
            "codex",
            "full_access",
            ["exec", "--json", "--dangerously-bypass-approvals-and-sandbox", "--skip-git-repo-check", "-C"],
        ),
        ("claude", "workspace_only", ["-p", "--output-format", "json", "--permission-mode", "acceptEdits"]),
        ("claude", "full_access", ["-p", "--output-format", "json", "--permission-mode", "bypassPermissions"]),
        ("droid", "workspace_only", ["exec", "-o", "json", "--auto", "low", "--cwd"]),
        ("droid", "full_access", ["exec", "-o", "json", "--skip-permissions-unsafe", "--cwd"]),
    ],
)
def test_argv_follows_the_permission_table(cli: str, permission: str, expected: list[str], tmp_path: Path) -> None:
    """Each (cli, permission) pair builds exactly its documented command, never --add-dir or --bare."""
    workdir = tmp_path / "copy"
    argv = host_cli_argv(cli, permission, "bin", workdir, "m")  # type: ignore[arg-type]
    tail = [str(workdir)] if cli != "claude" else []
    assert argv == ["bin", *expected, *tail, "--model", "m"]
    assert "--add-dir" not in argv
    assert "--bare" not in argv


def test_unknown_permission_is_refused(tmp_path: Path) -> None:
    """A permission outside the table never reaches a CLI."""
    with pytest.raises(host_agent.HostAgentRequestError):
        host_cli_argv("claude", "root", "bin", tmp_path, None)


@pytest.mark.parametrize("cli", ["codex", "claude", "droid"])
def test_turn_edits_a_copy_with_stripped_keys(
    cli: str, local: Settings, guest: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The CLI runs in a fresh copy under the state dir, without provider keys, and its edits come back."""
    monkeypatch.setenv("FAKE_CLI_NAME", cli)
    original = (guest / "solver.py").read_text()
    body = {
        "cli": cli,
        "model": "",
        "prompt": "Improve solve().",
        "permission": "workspace_only",
        "workspace_tar_b64": _workspace_tar(guest),
    }

    document = run_host_agent(body, local, job="job-1")

    assert document["status"] == "ok", document
    record = json.loads((tmp_path / "record.json").read_text())
    copy = Path(record["cwd"]).resolve()
    workspaces = (tmp_path / "state" / "workspaces" / "job-1").resolve()
    assert copy.parent == workspaces
    assert copy != guest.resolve()
    assert record["env"] == dict.fromkeys(STRIPPED)
    assert record["prompt"] == "Improve solve()."
    files = _members(document["result_tar_b64"])
    assert files["solver.py"].endswith("# improved\n")
    assert files["notes/plan.md"] == "plan\n"
    assert "stale.txt" not in files
    assert not any(name.endswith(".prompt.md") for name in files)
    assert (guest / "solver.py").read_text() == original
    assert not copy.exists()
    assert list(workspaces.iterdir()) == []
    assert document["usage"]["prompt_tokens"] == 120
    assert document["usage"]["completion_tokens"] == 30
    assert document["usage"]["cost"] == 0.0
    assert document["usage"]["model_ms"] > 0


def test_usage_cap_reports_reset_and_records_the_limit(
    local: Settings, guest: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A capped subscription answers subscription.rate_limited with the CLI's reset time."""
    monkeypatch.setenv("FAKE_CLI_NAME", "claude")
    monkeypatch.setenv("FAKE_CLI_MODE", "limit")
    body = {"cli": "claude", "model": "", "prompt": "x", "workspace_tar_b64": _workspace_tar(guest)}

    document = run_host_agent(body, local)

    assert document["status"] == "error"
    assert document["error"]["code"] == RATE_LIMITED_CODE
    reset = datetime.fromtimestamp(RESET_EPOCH, UTC).isoformat()
    assert document["error"]["reset_at"] == reset
    assert read_cli_limits(local)["claude"]["reset_at"] == reset


def test_archive_that_escapes_the_copy_is_refused(local: Settings, tmp_path: Path) -> None:
    """A guest tar member outside the copy fails the turn before any CLI runs."""
    buffer = io.BytesIO()
    with tarfile.open(fileobj=buffer, mode="w:gz") as archive:
        data = b"owned"
        member = tarfile.TarInfo("../escape.txt")
        member.size = len(data)
        archive.addfile(member, io.BytesIO(data))
    body = {"cli": "claude", "prompt": "x", "workspace_tar_b64": base64.b64encode(buffer.getvalue()).decode()}

    document = run_host_agent(body, local)

    assert document["status"] == "error"
    assert document["error"]["code"] == host_agent.FAILED_KEY
    assert not (tmp_path / "state" / "workspaces" / "escape.txt").exists()
    assert not (tmp_path / "record.json").exists()


@pytest.fixture
def database(tmp_path: Path) -> Iterator[Engine]:
    """A private funded wallet for the run's budget."""
    engine = create_engine(f"sqlite:///{tmp_path / 'host.db'}", connect_args={"check_same_thread": False})
    Base.metadata.create_all(engine)
    with Session(engine) as session:
        session.add(
            BillingCustomerModel(username="alice", stripe_customer_id="fixture", balance_cents=50, grant_remaining=0)
        )
        session.commit()
    yield engine
    engine.dispose()


@pytest.fixture
def gateway(database: Engine) -> Iterator[ModelGateway]:
    """The real parent gateway over a real budget."""
    ledger = BudgetService(engine=database)
    budget = ledger.create("alice", 20, idempotency_key="fixture")
    runtime = BudgetRuntime(ledger, username="alice", budget_id=budget.id, generation=0, phase="setup")
    gateway = ModelGateway(runtime)
    yield gateway
    gateway.close()


def _post(gateway: ModelGateway, token: str, body: dict | bytes) -> httpx.Response:
    """Call the gateway's capability over HTTP as the guest relay does.

    Args:
        gateway: The parent gateway.
        token: A route token the parent registered.
        body: JSON document, or raw bytes.

    Returns:
        The HTTP response.
    """
    content = body if isinstance(body, bytes) else json.dumps(body).encode()
    return httpx.post(
        f"{gateway.url}/_host_agent",
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
        content=content,
        trust_env=False,
        timeout=60,
    )


class _IdleRoute:
    """A registered proposer route that is never asked for a model call."""

    def dispatch(self, *args: object, **kwargs: object) -> None:
        """Refuse like a real model route refuses a path it does not serve.

        Raises:
            UnpricedOperationError: Always.
        """
        raise UnpricedOperationError("This scoped route cannot dispatch a different model or API operation.")

    def stop_batch(self) -> None:
        """Nothing to drain when the gateway closes."""


def _token(gateway: ModelGateway) -> str:
    """Give the gateway one proposer route and return its token.

    The route is never dispatched, so it needs no provider or catalog lookup.

    Args:
        gateway: The parent gateway.

    Returns:
        The route token the guest would hold.
    """
    gateway._routes["proposer-token"] = _IdleRoute()  # type: ignore[assignment]
    return "proposer-token"


def test_capability_records_a_zero_cost_turn(
    gateway: ModelGateway, local: Settings, guest: Path, database: Engine, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A bound capability answers the contract shape and settles the turn at zero cost."""
    monkeypatch.setenv("FAKE_CLI_NAME", "codex")
    bind_host_agent(gateway, local)
    body = {"cli": "codex", "model": "", "prompt": "x", "workspace_tar_b64": _workspace_tar(guest)}

    response = _post(gateway, _token(gateway), body)

    assert response.status_code == 200, response.text
    document = response.json()
    assert document["status"] == "ok"
    assert set(document) >= {"status", "result_tar_b64", "usage", "transcript_tail"}
    with Session(database) as session:
        operations = session.scalars(select(ExecutionOperationModel)).all()
    assert len(operations) == 1
    assert operations[0].state == "settled"
    assert operations[0].actual_units == 0
    assert operations[0].actual_wallet_units == 0
    assert host_agent_failure(gateway) is None


def test_capped_turn_fails_the_run_with_its_reset_time(
    gateway: ModelGateway, local: Settings, guest: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A usage cap answers 429 and leaves the run's failure: blackbox.host_agent_rate_limited with reset_at."""
    monkeypatch.setenv("FAKE_CLI_NAME", "claude")
    monkeypatch.setenv("FAKE_CLI_MODE", "limit")
    bind_host_agent(gateway, local)
    body = {"cli": "claude", "model": "", "prompt": "x", "workspace_tar_b64": _workspace_tar(guest)}

    response = _post(gateway, _token(gateway), body)

    assert response.status_code == 429
    assert response.json()["error"]["code"] == RATE_LIMITED_CODE
    failure = host_agent_failure(gateway)
    assert failure is not None
    assert failure.code == RATE_LIMITED_CODE
    message = failure_message(failure)
    reset = datetime.fromtimestamp(RESET_EPOCH, UTC).isoformat()
    assert reset in message
    assert "claude" in message


def test_oversized_workspace_is_refused(gateway: ModelGateway, local: Settings, tmp_path: Path) -> None:
    """A request above 32 MB is refused with 413 before any CLI runs."""
    bind_host_agent(gateway, local)
    handler_body = b"{" + b" " * (host_agent.MAX_REQUEST_BYTES + 1) + b"}"

    response = _post(gateway, _token(gateway), handler_body)

    assert response.status_code == 413
    assert not (tmp_path / "record.json").exists()


def test_capability_is_unbound_outside_local_mode(gateway: ModelGateway, guest: Path) -> None:
    """Hosted settings refuse to bind, and an unbound gateway answers 404."""
    with pytest.raises(ValueError, match="local mode"):
        bind_host_agent(gateway, settings.model_copy(update={"local_mode": False}))
    body = {"cli": "claude", "prompt": "x", "workspace_tar_b64": _workspace_tar(guest)}

    response = _post(gateway, _token(gateway), body)

    assert response.status_code == 404
    assert response.request.url.path == HOST_AGENT_PATH
