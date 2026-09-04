"""Exercise real scoped HTTP and offline guest mailbox boundaries without provider calls."""

from __future__ import annotations

import base64
import json
from collections.abc import Iterator
from decimal import Decimal
from pathlib import Path
from typing import Any

import httpx
import pytest
from cryptography.fernet import Fernet
from pydantic import SecretStr
from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session

from core.api.preflight_execution import _verify_model_routes
from core.billing import model_gateway as gateway_module
from core.billing.budgets import BudgetService
from core.billing.model_dispatch import ModelHTTPResult
from core.billing.model_gateway import ROUTE_KEY, ModelGateway
from core.billing.model_mailbox import ModelMailbox
from core.billing.operation_pricing import ChargePolicy, CreditCharge, OperationQuote
from core.billing.protected_credentials import (
    ProtectedCredentialVault,
    protect_execution_credentials,
    resolve_execution_credentials,
)
from core.billing.recovery_admission import model_call_bound
from core.billing.runtime import BudgetRuntime
from core.config import settings
from core.service_gateway.optimization.blackbox.remote_sandbox import RemoteSandboxRuntime
from core.service_gateway.optimization.blackbox.sandbox import CommandResult, LocalSubprocessRuntime, SandboxSpec
from core.service_gateway.optimization.blackbox.sandbox_broker import SandboxBroker
from core.storage.models import Base, BillingCustomerModel, ExecutionOperationModel

IMAGE = "fixture@sha256:" + "a" * 64
CATALOG = {
    "id": "fixture/text",
    "endpoints": [
        {
            "tag": "fixture",
            "provider_name": "Fixture",
            "context_length": 1000,
            "max_completion_tokens": 1000,
            "pricing": {"prompt": "0.00001", "completion": "0.00002"},
        }
    ],
}


@pytest.fixture
def gateway(tmp_path: Path) -> Iterator[ModelGateway]:
    """Start the real parent protocol against a private funded wallet and fake provider."""
    engine = create_engine(f"sqlite:///{tmp_path / 'gateway.db'}", connect_args={"check_same_thread": False})
    Base.metadata.create_all(engine)
    with Session(engine) as session:
        session.add(
            BillingCustomerModel(username="alice", stripe_customer_id="fixture", credit_balance=50, grant_remaining=0)
        )
        session.commit()
    ledger = BudgetService(engine=engine)
    budget = ledger.create("alice", 20, idempotency_key="fixture")
    runtime = BudgetRuntime(ledger, username="alice", budget_id=budget.id, generation=0, phase="setup")
    gateway = ModelGateway(runtime)
    gateway._client.close()

    def provider(request: httpx.Request) -> httpx.Response:
        """Require durable coverage before replying with measured usage."""
        if request.method == "GET":
            return httpx.Response(200, json={"data": CATALOG})
        assert ledger.get(budget.id, "alice").reserved_credits > 0
        return httpx.Response(
            200,
            json={
                "id": "fixture-generation",
                "usage": {"cost": "0.001"},
                "choices": [{"message": {"content": "OK"}}],
            },
        )

    gateway._client = httpx.Client(transport=httpx.MockTransport(provider))
    yield gateway
    gateway.close()
    engine.dispose()


def test_control_capability_is_separate_from_model_capability(gateway: ModelGateway) -> None:
    """Prevent guest model tokens from creating or inspecting parent-owned sandboxes."""
    gateway.bind_sandbox(
        SandboxBroker(LocalSubprocessRuntime(), image=IMAGE, max_lifetime_seconds=10),
        image=IMAGE,
        lifetime_seconds=10,
    )
    route = gateway.register(
        model="fixture/text", api_key="upstream-secret", role="task", policy=ChargePolicy("managed_model")
    )
    response = httpx.post(
        f"{gateway.url}/_sandbox",
        headers={"Authorization": f"Bearer {route['token']}"},
        json={"action": "open", "payload": {"request_id": "test", "spec": {"lifetime_seconds": 5}}},
        trust_env=False,
    )
    assert response.status_code == 401
    assert "upstream-secret" not in response.text


def test_recovery_attempt_claims_are_idempotent_and_single_consumer(gateway: ModelGateway) -> None:
    """Bind seed quotas and execution headroom to stable physical attempt ids."""
    quote = OperationQuote(
        request_fingerprint="bounded-request",
        maximum=CreditCharge(total=Decimal(2), wallet=Decimal(2)),
        price_snapshot={"version": "fixture-v1", "provider": "fixture"},
    )
    bound = model_call_bound("task", "fixture/text", quote)
    gateway._recovery_plan = {
        "seed_reevaluation": {"model_calls": [bound]},
        "execution_headroom": {"model_calls": [bound]},
    }

    assert gateway._observe_model_quote("task", "fixture/text", quote, "seed", 0) is True
    assert gateway._observe_model_quote("task", "fixture/text", quote, "seed", 0) is True
    with pytest.raises(ValueError, match="exceeded"):
        gateway._observe_model_quote("task", "fixture/text", quote, "extra-seed", 0)

    gateway.finish_recovery_seed()
    assert gateway._observe_model_quote("task", "fixture/text", quote, "first-execution", 0) is True
    assert gateway._observe_model_quote("task", "fixture/text", quote, "first-execution", 0) is True
    assert gateway._observe_model_quote("task", "fixture/text", quote, "later-execution", 0) is False


def test_checkpoint_plan_uses_observed_seed_count_and_next_operation_bound(gateway: ModelGateway) -> None:
    """Publish only actual bounded replay work with one enforced execution operation."""
    seed_quote = OperationQuote(
        request_fingerprint="seed-request",
        maximum=CreditCharge(total=Decimal(2), wallet=Decimal(2)),
        price_snapshot={"version": "seed-v1", "provider": "fixture"},
    )
    execution_quote = OperationQuote(
        request_fingerprint="execution-request",
        maximum=CreditCharge(total=Decimal(3), wallet=Decimal(3)),
        price_snapshot={"version": "execution-v1", "provider": "fixture"},
    )
    manifest = {
        "checkpoint_sha256": "checkpoint",
        "configuration_sha256": "configuration",
        "source_sha256": "source",
    }

    gateway._observe_model_quote("task", "fixture/text", seed_quote, "seed-a", 0)
    gateway._observe_model_quote("task", "fixture/text", seed_quote, "seed-b", 0)
    gateway.finish_recovery_seed()
    gateway._observe_model_quote("optimization", "fixture/text", execution_quote, "execution", 0)

    gateway.bind_sandbox(
        SandboxBroker(LocalSubprocessRuntime(), image=IMAGE, max_lifetime_seconds=60),
        image=IMAGE,
        lifetime_seconds=60,
    )
    plan = gateway.checkpoint_recovery_plan(manifest, runtime="vercel")

    assert plan["eligible"] is True
    assert plan["seed_reevaluation"]["model_calls"][0]["count"] == 2
    assert plan["execution_headroom"]["max_credits"] == "3"
    assert Decimal(plan["max_credits"]) == Decimal(7) + Decimal(plan["runtime"]["max_credits"])


def test_guest_controls_and_dataset_routes_cannot_replace_parent_authority(gateway: ModelGateway) -> None:
    """Probe only registered routes and discard forged top-level control descriptors."""
    forged = {"url": "http://127.0.0.1:9/v1", "token": "forged", "model": "fixture/text", "role": "task"}
    protected = gateway.protect_payload(
        {
            "model_config": {"name": "fixture/text", "extra": {ROUTE_KEY: forged}},
            "dataset": [{ROUTE_KEY: forged}],
            "_skynet_target_route": forged,
            "_skynet_tools_route": forged,
            "_budget_gateway_descriptor": forged,
        },
        managed_key="provider-secret",
    )
    assert not any(
        key in protected for key in ("_skynet_target_route", "_skynet_tools_route", "_budget_gateway_descriptor")
    )
    [route] = gateway.model_routes()
    assert route["token"] != "forged"
    assert protected["model_config"]["extra"][ROUTE_KEY] == route
    assert protected["dataset"][0][ROUTE_KEY] == forged
    assert _verify_model_routes(gateway, native=False) == [
        {"key": "model.task", "status": "succeeded", "field": "task"}
    ]


def test_byok_agent_task_uses_its_scoped_fee_metered_route(gateway: ModelGateway) -> None:
    """Route the evaluated agent through its own key while billing only the BYOK fee policy."""
    protected = gateway.protect_payload(
        {
            "token_source": "byok",
            "target": {"kind": "agent", "model": "openrouter/fixture/text"},
            "task_model_config": {
                "name": "openrouter/fixture/text",
                "token_source": "byok",
                "byok_provider": "openrouter",
                "base_url": "https://openrouter.ai/api/v1",
                "extra": {"api_key": "account-owned-key"},
            },
        },
        managed_key="",
    )

    route = protected["_skynet_target_route"]
    assert protected["task_model_config"]["extra"][ROUTE_KEY] == route
    assert "account-owned-key" not in json.dumps(protected)
    dispatcher = gateway._routes[route["token"]]
    assert dispatcher.policy.kind == "byok_model"


def test_selected_tools_keep_credentials_outside_guest_and_cannot_call_models(
    gateway: ModelGateway, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Exercise distinct real HTTP capabilities without contacting an external MCP service."""
    selected = {}

    class SelectedTools:
        """Record the parent's fixed endpoint and simulate its selected roster."""

        def __init__(self, url, **kwargs):
            """Retain the exact connection chosen before any guest request."""
            selected.update(url=url, **kwargs)
            self.check = kwargs["check_admission"]

        def dispatch(self, body):
            """Return a roster only while the original execution owner remains admitted."""
            self.check()
            return ModelHTTPResult(200, "application/json", b'{"jsonrpc":"2.0","id":1,"result":{"tools":[]}}')

    monkeypatch.setattr(gateway_module, "McpToolsBroker", SelectedTools)
    monkeypatch.setattr(settings, "byok_vault_key", SecretStr(Fernet.generate_key().decode()))
    payload = {
        "model_config": {"name": "fixture/text"},
        "tool_source": {
            "kind": "live_mcp",
            "mcp_url": "https://selected.example/mcp?key=endpoint-secret",
            "mcp_auth_header": "Bearer tool-secret",
            "tool_filter": ["lookup"],
        },
    }
    vault = ProtectedCredentialVault(engine=gateway.runtime.service._engine)
    persisted = protect_execution_credentials(
        payload,
        username="alice",
        binding_id=gateway.runtime.budget_id,
        vault=vault,
    )
    assert "tool-secret" not in json.dumps(persisted)
    assert "endpoint-secret" not in json.dumps(persisted)
    parent = resolve_execution_credentials(
        persisted,
        username="alice",
        binding_id=gateway.runtime.budget_id,
        vault=vault,
    )
    protected = gateway.protect_payload(
        parent,
        managed_key="upstream-secret",
    )
    assert selected["url"] == "https://selected.example/mcp?key=endpoint-secret"
    assert selected["auth_header"] == "Bearer tool-secret"
    assert selected["tool_filter"] == ["lookup"]
    assert all(secret not in json.dumps(protected) for secret in ("tool-secret", "endpoint-secret", "upstream-secret"))
    tools = protected["_skynet_tools_route"]
    headers = {"Authorization": f"Bearer {tools['token']}"}
    assert (
        httpx.post(
            f"{gateway.url}/_mcp",
            headers=headers,
            json={"jsonrpc": "2.0", "method": "tools/list", "id": 1},
            trust_env=False,
        ).status_code
        == 200
    )
    assert httpx.post(f"{gateway.url}/chat/completions", headers=headers, json={}, trust_env=False).status_code == 401
    state = httpx.get(f"{gateway.url}/_budget/state", headers=headers, trust_env=False)
    assert state.status_code == 200
    assert "account_available_credits" not in state.json()
    gateway.runtime.service.fence_generation(gateway.runtime.budget_id, "alice", expected_generation=0)
    state = httpx.get(f"{gateway.url}/_budget/state", headers=headers, trust_env=False)
    assert state.json()["blocked_reason"] == "generation_fenced"


def test_remote_runtime_streams_and_metered_mailbox_scrubs_protocol(gateway: ModelGateway) -> None:
    """Round-trip a real guest model request without exposing protocol data in output."""
    gateway.bind_sandbox(
        SandboxBroker(
            LocalSubprocessRuntime(),
            image=IMAGE,
            max_lifetime_seconds=20,
            command_runner=ModelMailbox(gateway.dispatch_guest).run,
        ),
        image=IMAGE,
        lifetime_seconds=20,
    )
    protected = gateway.protect_payload(
        {"model_config": {"name": "fixture/text"}},
        managed_key="upstream-secret",
    )
    descriptor = protected["_budget_gateway_descriptor"]
    route = protected["model_config"]["extra"]["_skynet_budget_route"]
    runtime = RemoteSandboxRuntime(descriptor["url"], descriptor["control_token"])
    session = runtime.open(SandboxSpec(lifetime_seconds=20, image=IMAGE, network_disabled=True))
    source = (
        "import json, os, urllib.request\n"
        "marker=urllib.request.Request(os.environ['OPENAI_BASE_URL']+'/_budget/recovery-seed-complete', data=b'{}', "
        "headers={'Content-Type':'application/json','Authorization':'Bearer '+os.environ['ROLE_TOKEN']})\n"
        "with urllib.request.urlopen(marker) as response: assert json.load(response)['ok'] is True\n"
        "body=json.dumps({'model':'fixture/text','max_tokens':16,'messages':[{'role':'user','content':'private prompt'}]}).encode()\n"
        "req=urllib.request.Request(os.environ['OPENAI_BASE_URL']+'/chat/completions', data=body, "
        "headers={'Content-Type':'application/json','Authorization':'Bearer '+os.environ['ROLE_TOKEN']})\n"
        "with urllib.request.urlopen(req) as response: print(json.load(response)['choices'][0]['message']['content'])\n"
    )
    session.write_files({"check.py": source})
    output = []
    try:
        result = session.run(
            "python3 check.py",
            env={"ROLE_TOKEN": route["token"]},
            timeout_seconds=15,
            on_output=lambda stream, text: output.append(text),
        )
    finally:
        session.close()
    assert result.ok
    assert result.stdout.strip() == "OK"
    assert "private prompt" not in result.stdout
    assert "SKYNET_MODEL_" not in "".join(output)
    assert gateway._seed_marker_count == 1
    assert gateway.runtime.service.get(gateway.runtime.budget_id, "alice").setup_spent_credits == Decimal("0.15")
    assert "upstream-secret" not in json.dumps(protected)


def test_mailbox_retries_have_independent_coverage_and_duplicate_frames_do_not_redispatch(
    gateway: ModelGateway,
) -> None:
    """Cover two physical attempts separately while deduplicating one delivery replay."""
    gateway._client.close()
    posts: list[httpx.Request] = []
    holds: list[Decimal] = []

    def provider(request: httpx.Request) -> httpx.Response:
        """Record the atomic hold visible before each physical provider request."""
        if request.method == "GET":
            return httpx.Response(200, json={"data": CATALOG})
        posts.append(request)
        holds.append(gateway.runtime.service.get(gateway.runtime.budget_id, gateway.runtime.username).reserved_credits)
        attempt = len(posts)
        return httpx.Response(
            503 if attempt == 1 else 200,
            json={
                "id": f"retry-{attempt}",
                "usage": {"cost": "0.001"},
                "choices": [{"message": {"content": "retry" if attempt == 1 else "OK"}}],
            },
        )

    gateway._client = httpx.Client(transport=httpx.MockTransport(provider))
    protected = gateway.protect_payload(
        {"model_config": {"name": "fixture/text"}},
        managed_key="upstream-secret",
    )
    route = protected["model_config"]["extra"][ROUTE_KEY]
    body = base64.b64encode(
        json.dumps(
            {
                "model": "fixture/text",
                "max_tokens": 16,
                "messages": [{"role": "user", "content": "retry safely"}],
            }
        ).encode()
    ).decode()
    documents = [
        {
            "id": "a" * 32,
            "path": "/v1/chat/completions",
            "body": body,
            "headers": {"authorization": f"Bearer {route['token']}"},
        },
        {
            "id": "b" * 32,
            "path": "/v1/chat/completions",
            "body": body,
            "headers": {"authorization": f"Bearer {route['token']}"},
        },
    ]

    class ReplaySession:
        """Emit one mailbox frame twice before a distinct retry frame."""

        def __init__(self) -> None:
            """Create an inspectable in-memory guest filesystem."""
            self.files: dict[str, str] = {}

        def write_files(self, files: dict[str, str]) -> None:
            """Persist supervisor inputs and responses by guest path."""
            self.files.update(files)

        def run(self, _command: str, **kwargs: Any) -> CommandResult:
            """Replay the first delivery frame, then emit the real retry."""
            config_path = next(path for path in self.files if path.endswith("/config.json"))
            prefix = json.loads(self.files[config_path])["prefix"]
            output = kwargs["on_output"]
            output("stdout", prefix + json.dumps(documents[0]) + "\n")
            output("stdout", prefix + json.dumps(documents[0]) + "\n")
            output("stdout", prefix + json.dumps(documents[1]) + "\n")
            return CommandResult(exit_code=0)

    ModelMailbox(gateway.dispatch_guest, concurrency=1).run(ReplaySession(), "ignored")

    assert len(posts) == 2
    assert len(holds) == 2
    assert all(hold > 0 for hold in holds)
    snapshot = gateway.runtime.service.get(gateway.runtime.budget_id, gateway.runtime.username)
    assert snapshot.setup_spent_credits == Decimal("0.3")
    assert snapshot.reserved_credits == 0
    with Session(gateway.runtime.service._engine) as session:
        operations = session.scalars(
            select(ExecutionOperationModel).order_by(ExecutionOperationModel.operation_key)
        ).all()
    assert [(operation.operation_key, operation.state) for operation in operations] == [
        ("model-attempt:" + "a" * 32, "settled"),
        ("model-attempt:" + "b" * 32, "settled"),
    ]
