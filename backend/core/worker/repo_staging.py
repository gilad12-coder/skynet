"""Stage a repository target's tree and secrets in the trusted parent before its sandbox opens."""

from __future__ import annotations

import contextlib
import copy
import shutil
import tempfile
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from ..billing.protected_credentials import ProtectedCredentialVault, resolve_repo_secrets
from ..connectors.github_repo import RepoSnapshot, fetch_snapshot, github_token, resolve_commit
from ..connectors.saved_secrets import SavedSecretStore
from ..service_gateway.optimization.blackbox.remote_sandbox import RemoteSandboxRuntime
from ..service_gateway.optimization.blackbox.repo_scorer import RepoScorer
from ..service_gateway.optimization.blackbox.repo_tree import REPO_SNAPSHOT_KEY
from ..service_gateway.optimization.blackbox.repo_workspace import RepoWorkspace
from ..service_gateway.optimization.blackbox.sandbox import SandboxSpec


@dataclass(frozen=True)
class StagedRepository:
    """A fetched tree plus the secrets only the parent's scorer box receives."""

    snapshot: RepoSnapshot
    secrets: dict[str, str]
    workdir: Path
    scorers: list[RepoScorer] = field(default_factory=list)

    def close_scorers(self) -> None:
        """Close the parent's scoring boxes; the gateway still stops any that fail to close."""
        scorers, self.scorers[:] = list(self.scorers), []
        for scorer in scorers:
            with contextlib.suppress(Exception):
                scorer.close()

    def cleanup(self) -> None:
        """Delete the fetched tree from the parent's disk."""
        shutil.rmtree(self.workdir, ignore_errors=True)


def is_repo_payload(payload: dict[str, Any]) -> bool:
    """Report whether a black-box payload optimizes a repository.

    Args:
        payload: Black-box run payload.

    Returns:
        Whether its target is a repository.
    """
    target = payload.get("target")
    return isinstance(target, dict) and target.get("kind") == "repo" and isinstance(target.get("repo"), dict)


def stage_repository(
    payload: dict[str, Any],
    *,
    username: str,
    binding_id: str,
    engine: Any,
) -> tuple[dict[str, Any], StagedRepository]:
    """Fetch the pinned tree and decrypt the run's secrets in the parent.

    Args:
        payload: Parent payload whose secrets are still vault references.
        username: Owner of the run and of the GitHub connection.
        binding_id: Execution budget the vaulted secrets are bound to.
        engine: SQLAlchemy engine for the vaults.

    Returns:
        A payload copy that pins the commit, lists no secret entries and names
        the packed tree, plus the staged tree and secrets for the parent.
    """
    result = copy.deepcopy(payload)
    repo = result["target"]["repo"]
    secrets = resolve_repo_secrets(
        result,
        username=username,
        binding_id=binding_id,
        vault=ProtectedCredentialVault(engine=engine),
        saved=SavedSecretStore(engine),
    )
    token = github_token(engine, username)
    commit = repo.get("commit") or resolve_commit(token, repo["repository"], repo.get("branch"))
    workdir = Path(tempfile.mkdtemp(prefix="skynet-repo-"))
    try:
        snapshot = fetch_snapshot(repo["repository"], commit, token, workdir)
    except BaseException:
        shutil.rmtree(workdir, ignore_errors=True)
        raise
    repo["commit"] = commit
    repo["secrets"] = []
    result[REPO_SNAPSHOT_KEY] = {
        "archive": str(snapshot.archive),
        "commit": commit,
        "readonly_paths": list(snapshot.readonly_paths),
        "secret_names": sorted(secrets),
    }
    return result, StagedRepository(snapshot=snapshot, secrets=secrets, workdir=workdir)


def bind_repo_scorer(payload: dict[str, Any], staged: StagedRepository, gateway: Any, *, owner_id: str) -> None:
    """Score the run's versions in a parent-owned box and hand the guest only its route.

    The box is opened through the gateway's own metered sandbox control, so
    it is billed and cleaned up like the guest's, but the guest never holds
    its control token, its secrets or its filesystem.

    Args:
        payload: Protected payload, updated in place with the evaluator route.
        staged: The fetched tree and decrypted secrets.
        gateway: The run's model gateway, already bound to its sandbox broker.
        owner_id: Job identity naming the box's operations.
    """
    descriptor = payload["_budget_gateway_descriptor"]
    target = payload["target"]
    scorer_spec = payload["scorer"]
    scorer = RepoScorer(
        RepoWorkspace(
            runtime=RemoteSandboxRuntime(descriptor["url"], descriptor["control_token"]),
            spec=SandboxSpec(
                lifetime_seconds=descriptor["lifetime_seconds"],
                image=descriptor["image"],
                network_disabled=True,
                operation_key=f"repo-scorer:{owner_id}",
            ),
            archive=staged.snapshot.archive,
            editable_paths=target["repo"]["editable_paths"],
            readonly_paths=staged.snapshot.readonly_paths,
            setup_command=target.get("setup_command"),
            secrets=staged.secrets,
        ),
        str(scorer_spec["metric_code"]),
        timeout_seconds=float(scorer_spec["timeout_seconds"]),
    )
    staged.scorers.append(scorer)
    payload["_skynet_evaluator_route"] = gateway.bind_evaluator(scorer)
