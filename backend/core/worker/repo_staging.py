"""Stage a repository target's tree and secrets in the trusted parent before its sandbox opens."""

from __future__ import annotations

import contextlib
import copy
import json
import logging
import shutil
import tempfile
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from ..billing.protected_credentials import ProtectedCredentialVault, resolve_repo_secrets
from ..connectors.github_publish import RepoPublishError, open_pull_request, push_version
from ..connectors.github_repo import RepoFetchError, RepoSnapshot, fetch_snapshot, github_token, resolve_commit
from ..connectors.saved_secrets import SavedSecretStore
from ..service_gateway.optimization.blackbox.remote_sandbox import RemoteSandboxRuntime
from ..service_gateway.optimization.blackbox.repo_scorer import RepoScorer
from ..service_gateway.optimization.blackbox.repo_setup import infer_setup_command
from ..service_gateway.optimization.blackbox.repo_tree import REPO_SNAPSHOT_KEY, patch_paths, patch_violations
from ..service_gateway.optimization.blackbox.repo_workspace import RepoWorkspace
from ..service_gateway.optimization.blackbox.sandbox import SandboxSpec

logger = logging.getLogger(__name__)

PULL_REQUEST_DETAIL = "pull_request"
_SETUP_ANSWER_TOKENS = 1_024


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


def _setup_asker(payload: dict[str, Any], gateway: Any) -> Callable[[str], str | None] | None:
    """Return a metered one-shot call to the run's optimization model, if it has one.

    Args:
        payload: Protected payload whose model roles are already registered.
        gateway: The run's model gateway.

    Returns:
        A function sending one prompt and returning the reply text, or
        ``None`` when the run has no optimization model to ask.
    """
    # An economy run's managed chat calls wait for a half-price batch, which
    # can take far longer than staging should.
    if payload.get("economy_mode"):
        return None
    route = next((route for route in gateway.model_routes() if route["role"] == "optimization"), None)
    if route is None:
        return None

    def ask(prompt: str) -> str | None:
        """Send one prompt through the run's metered optimization route.

        Args:
            prompt: The question.

        Returns:
            The model's reply, or ``None`` when the provider refused it.
        """
        body = {
            "model": route["model"],
            "messages": [{"role": "user", "content": prompt}],
            "max_tokens": _SETUP_ANSWER_TOKENS,
        }
        response = gateway.dispatch_guest(route["token"], "/v1/chat/completions", body, {})
        if not 200 <= response.status < 300:
            return None
        content = json.loads(response.body)["choices"][0]["message"].get("content")
        return content if isinstance(content, str) else None

    return ask


def infer_repo_setup(payload: dict[str, Any], staged: StagedRepository, gateway: Any) -> str | None:
    """Fill in the target's setup command from the fetched tree when the client sent none.

    Args:
        payload: Protected payload, updated in place.
        staged: The fetched tree.
        gateway: The run's model gateway, whose optimization model is asked.

    Returns:
        The inferred command, or ``None`` when the client named one or the
        repository needs no setup.
    """
    target = payload["target"]
    if (target.get("setup_command") or "").strip():
        return None
    command = infer_setup_command(staged.snapshot.archive, ask=_setup_asker(payload, gateway))
    target["setup_command"] = command
    return command


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


def _version_score(result: dict[str, Any], candidate: str) -> float | None:
    """Return the score the run ranked one version by.

    Args:
        result: Finished black-box result.
        candidate: The version's patch.

    Returns:
        Its recorded score, or ``None`` when the run never scored it.
    """
    for version in result.get("versions") or []:
        if isinstance(version, dict) and version.get("candidate") == candidate:
            score = version.get("score")
            return float(score) if isinstance(score, int | float) else None
    return None


def improved_patch(result: dict[str, Any]) -> str | None:
    """Return the best version when it beat the starting code, else ``None``.

    Held-out scores decide when the run has them; a run without a hold-out
    split compares the versions' own scores instead.

    Args:
        result: Finished black-box result.

    Returns:
        The best version's patch, or ``None`` when it is empty or no better.
    """
    best = result.get("best_candidate")
    if not isinstance(best, str) or not best.strip() or result.get("regression_guard_applied"):
        return None
    baseline, optimized = result.get("baseline_test_metric"), result.get("optimized_test_metric")
    if baseline is None or optimized is None:
        baseline, optimized = _version_score(result, result.get("seed_candidate") or ""), _version_score(result, best)
    if baseline is None or optimized is None:
        return None
    return best if optimized > baseline else None


def _description(result: dict[str, Any], patch: str, run_url: str) -> str:
    """Write the pull request description.

    Args:
        result: Finished black-box result.
        patch: The published version.
        run_url: Link to the run in the web app.

    Returns:
        Markdown body.
    """
    baseline, optimized = result.get("baseline_test_metric"), result.get("optimized_test_metric")
    if baseline is None or optimized is None:
        baseline, optimized = _version_score(result, result.get("seed_candidate") or ""), _version_score(result, patch)
    files = sorted(set(patch_paths(patch)))
    listed = "\n".join(f"- `{path}`" for path in files[:50])
    more = f"\n- and {len(files) - 50} more" if len(files) > 50 else ""
    return (
        f"Skynet found this version while optimizing the repository with {result.get('engine_used', 'an agent')}.\n\n"
        f"Score went from {baseline:.4g} to {optimized:.4g}.\n\n"
        f"Changed files:\n{listed}{more}\n\n"
        f"Review the run: {run_url}\n"
    )


def publish_improvement(
    result: dict[str, Any],
    payload: dict[str, Any],
    staged: StagedRepository,
    *,
    username: str,
    engine: Any,
    optimization_id: str,
    app_url: str,
) -> dict[str, Any] | None:
    """Open a draft pull request with the run's best version when it beat the start.

    Never raises: the run already finished, so a failure is recorded on the
    result for its owner to read instead.

    Args:
        result: Finished black-box result, updated in place.
        payload: The staged payload, which pins the commit.
        staged: The fetched tree, whose read-only paths still apply.
        username: Owner of the run and of the GitHub connection.
        engine: SQLAlchemy engine holding the connector vault.
        optimization_id: The run, named in the branch.
        app_url: Public origin of the web app.

    Returns:
        What was recorded under ``details.pull_request``, or ``None`` when the
        run did not improve.
    """
    patch = improved_patch(result)
    if patch is None:
        return None
    repo = payload["target"]["repo"]
    outcome: dict[str, Any]
    # The patch came back from the guest, so the editing rules are checked
    # again before anything reaches the user's repository.
    problems = patch_violations(patch, repo["editable_paths"], staged.snapshot.readonly_paths)
    if problems:
        outcome = {"error": f"The best version breaks the editing rules: {problems[0]}"}
    else:
        branch = f"skynet/optimize-{optimization_id[:12]}"
        run_url = f"{app_url.rstrip('/')}/optimizations/{optimization_id}"
        try:
            token = github_token(engine, username)
            push_version(
                repo["repository"],
                repo["commit"],
                patch,
                branch,
                f"Apply the best version from Skynet run {optimization_id[:12]}",
                token,
            )
            change = open_pull_request(
                token,
                repo["repository"],
                head=branch,
                base_branch=repo.get("branch"),
                title=f"Skynet: optimized version from run {optimization_id[:12]}",
                body=_description(result, patch, run_url),
            )
            outcome = {"url": change.url, "number": change.number, "branch": change.branch, "draft": change.draft}
        except (RepoFetchError, RepoPublishError) as error:
            outcome = {"error": str(error)}
        except Exception:  # isolation boundary: a finished run must keep its result
            logger.exception("Publishing the best version of %s failed", optimization_id)
            outcome = {"error": "The pull request could not be opened."}
    details = result.setdefault("details", {})
    details[PULL_REQUEST_DETAIL] = outcome
    return outcome
