"""Push a run's best repository version to a new branch and open a draft pull request.

Runs only in the trusted parent, after the run ends. The version is applied to
a fresh clone of the pinned commit, so the branch holds exactly one commit on
top of the code the run started from.
"""

from __future__ import annotations

import shutil
import subprocess
import tempfile
from dataclasses import dataclass
from pathlib import Path

from ..api.errors import DomainError
from .github import API_URL, PROVIDER, _headers
from .github_repo import GITHUB_HOST, RepoFetchError, _git, git_auth_env
from .transport import get_json, request

COMMIT_AUTHOR = ["-c", "user.name=Skynet", "-c", "user.email=noreply@skynetml.com", "-c", "commit.gpgsign=false"]
# The branch holds a reviewed diff, never LFS objects, so LFS filters stay off.
_NO_LFS = ["-c", "filter.lfs.process=", "-c", "filter.lfs.clean=cat", "-c", "filter.lfs.smudge=cat"]


class RepoPublishError(RuntimeError):
    """Explain, in words a run's owner can act on, why the pull request was not opened."""


@dataclass(frozen=True)
class PublishedChange:
    """The branch and pull request holding a run's best version."""

    branch: str
    url: str
    number: int
    draft: bool


def _base_branch(token: str, repository: str, branch: str | None) -> str:
    """Return the branch the pull request targets.

    Args:
        token: GitHub token.
        repository: ``owner/name``.
        branch: Branch the run started from, if it named one.

    Returns:
        That branch, or the repository's default branch.
    """
    if branch:
        return branch
    repo = get_json(f"{API_URL}/repos/{repository}", provider=PROVIDER, headers=_headers(token))
    return str(repo["default_branch"])


def push_version(
    repository: str,
    commit: str,
    patch: str,
    branch: str,
    message: str,
    token: str | None,
    *,
    remote: str | None = None,
) -> None:
    """Commit ``patch`` on top of ``commit`` and push it as a new branch.

    Args:
        repository: ``owner/name``.
        commit: The pinned commit the version was made against.
        patch: ``git diff --binary`` output of the version.
        branch: New branch name.
        message: Commit message.
        token: GitHub token; ``None`` for a local remote.
        remote: Push URL override, used by tests with a local repository.

    Raises:
        RepoPublishError: When the clone, the patch or the push fails.
    """
    environment = git_auth_env(token)
    workdir = Path(tempfile.mkdtemp(prefix="skynet-publish-"))
    try:
        _git(["init", "--quiet"], workdir, environment)
        _git(["remote", "add", "origin", remote or f"{GITHUB_HOST}/{repository}.git"], workdir, environment)
        _git(["fetch", "--quiet", "--depth", "1", "origin", commit], workdir, environment)
        _git([*_NO_LFS, "-c", "advice.detachedHead=false", "checkout", "--quiet", "FETCH_HEAD"], workdir, environment)
        applied = subprocess.run(
            ["git", "apply", "--index", "--binary", "--whitespace=nowarn", "-"],
            cwd=workdir,
            input=patch,
            capture_output=True,
            text=True,
            check=False,
        )
        if applied.returncode != 0:
            raise RepoPublishError("The best version no longer applies to the commit the run started from.")
        _git([*COMMIT_AUTHOR, *_NO_LFS, "commit", "--quiet", "--no-verify", "-m", message], workdir, environment)
        _git(["push", "--quiet", "origin", f"HEAD:refs/heads/{branch}"], workdir, environment)
    except RepoFetchError as error:
        raise RepoPublishError(f"Could not push the branch: {error}") from error
    finally:
        shutil.rmtree(workdir, ignore_errors=True)


def open_pull_request(
    token: str, repository: str, *, head: str, base_branch: str | None, title: str, body: str
) -> PublishedChange:
    """Open a draft pull request, or a regular one where the plan has no drafts.

    Args:
        token: GitHub token with ``repo`` scope.
        repository: ``owner/name``.
        head: The pushed branch.
        base_branch: Branch to merge into; ``None`` picks the default branch.
        title: Pull request title.
        body: Pull request description.

    Returns:
        The opened pull request.

    Raises:
        RepoPublishError: When GitHub refuses the request.
    """
    url = f"{API_URL}/repos/{repository}/pulls"
    try:
        fields = {"title": title, "head": head, "base": _base_branch(token, repository, base_branch), "body": body}
        response = request("POST", url, provider=PROVIDER, headers=_headers(token), json={**fields, "draft": True})
    except DomainError as error:
        # Private repositories on free plans refuse drafts with a 422.
        if error.params.get("status_code") != 422:
            raise RepoPublishError("GitHub refused to open the pull request.") from error
        try:
            response = request("POST", url, provider=PROVIDER, headers=_headers(token), json=fields)
        except DomainError as retry_error:
            raise RepoPublishError("GitHub refused to open the pull request.") from retry_error
    opened = response.json()
    return PublishedChange(
        branch=head, url=str(opened["html_url"]), number=int(opened["number"]), draft=bool(opened.get("draft"))
    )
