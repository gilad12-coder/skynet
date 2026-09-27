"""GitHub connector: browse repositories and import a data file from one.

Linking works through a GitHub OAuth app (``repo`` scope so private
repositories resolve) or a pasted personal access token. Browsing lists the
account's repositories, then walks a repository's tree through the contents
API; CSV, TSV, JSON, JSONL and Parquet files are importable.
"""

from __future__ import annotations

import hashlib
import threading
import time
from typing import Any
from urllib.parse import quote

from ..api.errors import DomainError
from ..config import settings
from .base import Credential, Entry, import_file, preview_file, range_header
from .oauth import OAuthApp
from .oauth import oauth_available as _oauth_available
from .tabular import check_size, is_supported
from .transport import download, get_json
from .vault import ConnectorSecret

PROVIDER = "github"
API_URL = "https://api.github.com"
SCOPES = "repo read:user"
REPO_LIMIT = 100
TREE_TTL_SECONDS = 300.0

_trees: dict[tuple[str, str, str], tuple[float, list[str] | None]] = {}
_tree_locks: dict[tuple[str, str, str], threading.Lock] = {}
_trees_lock = threading.Lock()


def oauth_app() -> OAuthApp:
    """Describe the GitHub OAuth app from settings.

    Returns:
        The app; ``client_id`` is ``None`` when unconfigured.
    """
    secret = settings.github_oauth_client_secret
    return OAuthApp(
        provider=PROVIDER,
        authorize_url="https://github.com/login/oauth/authorize",
        token_url="https://github.com/login/oauth/access_token",
        scopes=SCOPES,
        client_id=settings.github_oauth_client_id,
        client_secret=secret.get_secret_value() if secret is not None else None,
        extra_authorize_params={},
    )


def oauth_available() -> bool:
    """Report whether "Continue with GitHub" can be offered.

    Returns:
        ``True`` when the client id and the vault key are configured.
    """
    return _oauth_available(oauth_app())


def _headers(token: str, accept: str = "application/vnd.github+json") -> dict[str, str]:
    """Bearer headers for the GitHub API.

    Args:
        token: The access token.
        accept: Media type to request.

    Returns:
        The headers.
    """
    return {"Authorization": f"Bearer {token}", "Accept": accept, "X-GitHub-Api-Version": "2022-11-28"}


def fetch_account_label(token: str) -> str | None:
    """Look up the login behind a token.

    Args:
        token: A GitHub token.

    Returns:
        The login, or ``None`` when the lookup fails.
    """
    try:
        body = get_json(f"{API_URL}/user", provider=PROVIDER, headers=_headers(token))
    except DomainError:
        return None
    login = body.get("login") if isinstance(body, dict) else None
    return login if isinstance(login, str) else None


def verify_credentials(fields: dict[str, str]) -> Credential:
    """Validate a pasted personal access token against ``/user``.

    Args:
        fields: ``{"token": ...}``.

    Returns:
        The credential to store, labelled with the login.

    Raises:
        DomainError: 400 when GitHub rejects the token.
    """
    token = fields.get("token", "").strip()
    if not token:
        raise DomainError("connectors.invalid_credentials", status=400)
    try:
        body = get_json(f"{API_URL}/user", provider=PROVIDER, headers=_headers(token))
    except DomainError as exc:
        if exc.code == "connectors.rejected":
            raise DomainError("connectors.invalid_credentials", status=400) from exc
        raise
    login = body.get("login") if isinstance(body, dict) else None
    return Credential(secret=token, auth_method="token", account_label=login if isinstance(login, str) else None)


def _split_location(location: str) -> tuple[str, str, str]:
    """Split ``"owner/repo/dir/file"`` into ``(owner, repo, "dir/file")``.

    Args:
        location: A browse location or file ref.

    Returns:
        The parts; ``path`` is empty at the repository root.

    Raises:
        DomainError: 400 when the location has no ``owner/repo`` prefix.
    """
    parts = location.strip("/").split("/", 2)
    if len(parts) < 2 or not parts[0] or not parts[1]:
        raise DomainError("connectors.invalid_ref", status=400)
    return parts[0], parts[1], parts[2] if len(parts) == 3 else ""


def _list_repos(token: str, search: str) -> list[Entry]:
    """List repositories the account can see, most recently pushed first.

    A ``search`` shaped like ``owner/repo`` is also offered directly, so a
    public repository outside the account can be opened by name.

    Args:
        token: Bearer token.
        search: Substring filter on ``owner/repo``.

    Returns:
        Folder entries keyed ``owner/repo``.
    """
    body = get_json(
        f"{API_URL}/user/repos",
        provider=PROVIDER,
        headers=_headers(token),
        params={"per_page": REPO_LIMIT, "sort": "pushed", "affiliation": "owner,collaborator,organization_member"},
    )
    needle = search.strip().lower()
    entries = [
        Entry(ref=repo["full_name"], name=repo["full_name"], kind="folder", modified=repo.get("pushed_at"))
        for repo in body or []
        if isinstance(repo.get("full_name"), str) and needle in repo["full_name"].lower()
    ]
    if needle.count("/") == 1 and all(needle.split("/")) and not any(e.ref.lower() == needle for e in entries):
        entries.insert(0, Entry(ref=search.strip(), name=search.strip(), kind="folder"))
    return entries


def _contents_url(owner: str, repo: str, path: str) -> str:
    """Build the contents-API URL for a path.

    Args:
        owner: Repository owner.
        repo: Repository name.
        path: Path inside the repository.

    Returns:
        The URL.
    """
    return f"{API_URL}/repos/{quote(owner, safe='')}/{quote(repo, safe='')}/contents/{quote(path)}"


def _list_tree(token: str, owner: str, repo: str, path: str) -> list[Entry]:
    """List one directory of a repository, folders first.

    Args:
        token: Bearer token.
        owner: Repository owner.
        repo: Repository name.
        path: Directory path, empty for the root.

    Returns:
        Folder entries for sub-directories and file entries for importable files.
    """
    body = get_json(_contents_url(owner, repo, path), provider=PROVIDER, headers=_headers(token))
    if not isinstance(body, list):
        raise DomainError("connectors.invalid_ref", status=400)
    folders = [
        Entry(ref=f"{owner}/{repo}/{item['path']}", name=item["name"], kind="folder")
        for item in body
        if item.get("type") == "dir" and isinstance(item.get("path"), str)
    ]
    files = [
        Entry(ref=f"{owner}/{repo}/{item['path']}", name=item["name"], kind="file", size=item.get("size"))
        for item in body
        if item.get("type") == "file" and isinstance(item.get("path"), str) and is_supported(item["name"])
    ]
    return folders + files


def web_url(secret: ConnectorSecret, location: str) -> str | None:
    """Link to a browse location on GitHub.

    Args:
        secret: The stored connector.
        location: Empty for the repositories, else ``owner/repo[/path]``.

    Returns:
        The URL.
    """
    if not location:
        return "https://github.com"
    owner, repo, path = _split_location(location)
    base = f"https://github.com/{quote(owner, safe='')}/{quote(repo, safe='')}"
    return f"{base}/tree/HEAD/{quote(path)}" if path else base


def _repo_files(token: str, owner: str, repo: str) -> list[str] | None:
    """List every file path in a repository in one call, cached briefly.

    Probes of sibling folders run in parallel against the same repository, so
    each repository's tree is fetched once under its own lock.

    Args:
        token: Bearer token.
        owner: Repository owner.
        repo: Repository name.

    Returns:
        The file paths, or ``None`` when GitHub truncated the tree.
    """
    key = (hashlib.sha256(token.encode()).hexdigest(), owner, repo)
    with _trees_lock:
        lock = _tree_locks.setdefault(key, threading.Lock())
    with lock:
        cached = _trees.get(key)
        if cached is not None and cached[0] > time.monotonic():
            return cached[1]
        body = get_json(
            f"{API_URL}/repos/{quote(owner, safe='')}/{quote(repo, safe='')}/git/trees/HEAD",
            provider=PROVIDER,
            headers=_headers(token),
            params={"recursive": "1"},
        )
        files = (
            None
            if not isinstance(body, dict) or body.get("truncated")
            else [
                item["path"]
                for item in body.get("tree") or []
                if item.get("type") == "blob" and isinstance(item.get("path"), str)
            ]
        )
        _trees[key] = (time.monotonic() + TREE_TTL_SECONDS, files)
        return files


def has_importable(secret: ConnectorSecret, ref: str) -> bool | None:
    """Settle whether a repository or directory holds an importable file, from the repository tree.

    Args:
        secret: The stored connector.
        ref: ``owner/repo[/dir]``.

    Returns:
        ``True``, ``False``, or ``None`` when the tree is too big to tell.
    """
    owner, repo, path = _split_location(ref)
    files = _repo_files(secret.access_token, owner, repo)
    if files is None:
        return None
    prefix = f"{path}/" if path else ""
    return any(f.startswith(prefix) and is_supported(f) for f in files)


def browse(secret: ConnectorSecret, location: str, search: str) -> list[Entry]:
    """List repositories at the root, or one directory of a repository.

    Args:
        secret: The stored connector.
        location: Empty for the root, else ``owner/repo[/dir]``.
        search: Repository filter, honoured at the root.

    Returns:
        The entries.
    """
    if not location:
        return _list_repos(secret.access_token, search)
    owner, repo, path = _split_location(location)
    return _list_tree(secret.access_token, owner, repo, path)


def _fetcher(token: str, ref: str):
    """Build the download closure for one file ref.

    Args:
        token: Bearer token.
        ref: ``owner/repo/path/to/file``.

    Returns:
        A callable taking an optional byte cap and returning ``(bytes, truncated)``.
    """
    owner, repo, path = _split_location(ref)
    if not path:
        raise DomainError("connectors.invalid_ref", status=400)
    url = _contents_url(owner, repo, path)

    def fetch(max_bytes: int | None) -> tuple[bytes, bool]:
        """Download the raw file, honouring the cap.

        Args:
            max_bytes: Byte cap for previews, ``None`` for the whole file.

        Returns:
            ``(content, truncated)``.
        """
        headers = {**_headers(token, accept="application/vnd.github.raw+json"), **range_header(max_bytes)}
        return download(url, provider=PROVIDER, headers=headers, max_bytes=max_bytes)

    return fetch


def preview(secret: ConnectorSecret, ref: str) -> dict[str, Any]:
    """Decode the first rows of a repository file.

    Args:
        secret: The stored connector.
        ref: ``owner/repo/path/to/file``.

    Returns:
        ``{"columns": [...], "rows": [...], "num_rows_total": None}``.
    """
    return preview_file(_fetcher(secret.access_token, ref), ref)


def import_ref(secret: ConnectorSecret, ref: str) -> tuple[list[dict[str, Any]], dict[str, Any], str]:
    """Download a repository file and decode every row.

    Args:
        secret: The stored connector.
        ref: ``owner/repo/path/to/file``.

    Returns:
        ``(rows, column_schema, default_name)``.
    """
    owner, repo, path = _split_location(ref)
    meta = get_json(_contents_url(owner, repo, path), provider=PROVIDER, headers=_headers(secret.access_token))
    check_size(meta.get("size") if isinstance(meta, dict) else None)
    rows, schema = import_file(_fetcher(secret.access_token, ref), ref)
    return rows, schema, f"{repo}/{path.rsplit('/', 1)[-1]}"
