"""Google Cloud Storage connector.

Linking works through Google OAuth when the deployment registered a Google
OAuth client, or with a service-account key, optionally pinned to one bucket.
Tokens carry the read-only storage scope and the JSON API is used directly, so
no Google client library is needed for the calls involved: list buckets, list
objects, download an object. A service account lists its own project's
buckets; a user account has no single project, so its root lists the projects
it can see (Cloud Resource Manager) and each project opens onto its buckets.
"""

from __future__ import annotations

import json
from typing import Any
from urllib.parse import quote

from ..api.errors import DomainError
from ..config import settings
from .base import Credential, Entry, Fetch, import_file, preview_file, range_header, split_location
from .google_auth import parse_service_account, service_account_token
from .oauth import OAuthApp
from .oauth import oauth_available as _oauth_available
from .tabular import check_size, is_supported
from .transport import download, get_json
from .vault import ConnectorSecret

PROVIDER = "gcs"
API_URL = "https://storage.googleapis.com/storage/v1"
PROJECTS_URL = "https://cloudresourcemanager.googleapis.com/v1/projects"
USERINFO_URL = "https://www.googleapis.com/oauth2/v3/userinfo"
SCOPE = "https://www.googleapis.com/auth/devstorage.read_only"
# ``cloud-platform.read-only`` is what lets a user token list its projects; buckets are listed per project.
OAUTH_SCOPES = f"openid email {SCOPE} https://www.googleapis.com/auth/cloud-platform.read-only"
PROJECT_PREFIX = "project:"
LIST_LIMIT = 1000


def oauth_app() -> OAuthApp:
    """Describe the Google OAuth client from settings.

    Returns:
        The app; ``client_id`` is ``None`` when unconfigured.
    """
    secret = settings.google_oauth_client_secret
    return OAuthApp(
        provider=PROVIDER,
        authorize_url="https://accounts.google.com/o/oauth2/v2/auth",
        token_url="https://oauth2.googleapis.com/token",
        scopes=OAUTH_SCOPES,
        client_id=settings.google_oauth_client_id,
        client_secret=secret.get_secret_value() if secret is not None else None,
        extra_authorize_params={"access_type": "offline", "prompt": "consent", "include_granted_scopes": "true"},
    )


def oauth_available() -> bool:
    """Report whether "Continue with Google" can be offered.

    Returns:
        ``True`` when the client id and the vault key are configured.
    """
    return _oauth_available(oauth_app())


def fetch_account_label(token: str) -> str | None:
    """Look up the e-mail behind an OAuth token for the connector card.

    Args:
        token: A Google access token.

    Returns:
        The account e-mail, or ``None`` when Google withholds it.
    """
    try:
        body = get_json(USERINFO_URL, provider=PROVIDER, headers=_bearer_headers(token))
    except DomainError:
        return None
    email = body.get("email") if isinstance(body, dict) else None
    return email if isinstance(email, str) else None


def _config(secret: ConnectorSecret) -> dict[str, Any]:
    """Decode the stored credential JSON.

    Args:
        secret: The vault entry.

    Returns:
        ``{"service_account": {...}, "bucket": str}``.
    """
    return json.loads(secret.access_token)


def _bearer_headers(token: str) -> dict[str, str]:
    """Bearer headers for Google APIs.

    Args:
        token: The access token.

    Returns:
        The headers.
    """
    return {"Authorization": f"Bearer {token}", "Accept": "application/json"}


def _headers(config: dict[str, Any]) -> dict[str, str]:
    """Mint a bearer token for the stored service account.

    Args:
        config: Decoded credentials.

    Returns:
        The request headers.
    """
    return _bearer_headers(service_account_token(config["service_account"], SCOPE, PROVIDER))


def _secret_headers(secret: ConnectorSecret) -> dict[str, str]:
    """Bearer headers for a stored connector, OAuth token or service-account key.

    Args:
        secret: The vault entry.

    Returns:
        The request headers.
    """
    if secret.auth_method == "oauth":
        return _bearer_headers(secret.access_token)
    return _headers(_config(secret))


def _list_projects(headers: dict[str, str]) -> list[Entry]:
    """List the active projects a user account can see.

    Args:
        headers: Bearer headers.

    Returns:
        Folder entries keyed ``project:<id>``.
    """
    body = get_json(PROJECTS_URL, provider=PROVIDER, headers=headers, params={"filter": "lifecycleState:ACTIVE"})
    return [
        Entry(ref=f"{PROJECT_PREFIX}{p['projectId']}", name=p.get("name") or p["projectId"], kind="folder")
        for p in (body.get("projects") if isinstance(body, dict) else None) or []
        if isinstance(p.get("projectId"), str)
    ]


def _list_buckets(headers: dict[str, str], project_id: str) -> list[Entry]:
    """List the buckets of the service account's project.

    Args:
        headers: Bearer headers.
        project_id: GCP project id from the key.

    Returns:
        Folder entries keyed by bucket name.
    """
    body = get_json(
        f"{API_URL}/b",
        provider=PROVIDER,
        headers=headers,
        params={"project": project_id, "fields": "items(name,timeCreated)", "maxResults": LIST_LIMIT},
    )
    return [
        Entry(ref=item["name"], name=item["name"], kind="folder", modified=item.get("timeCreated"))
        for item in body.get("items") or []
        if isinstance(item.get("name"), str)
    ]


def _list_objects(headers: dict[str, str], bucket: str, prefix: str) -> list[Entry]:
    """List one "directory" of a bucket.

    Args:
        headers: Bearer headers.
        bucket: Bucket name.
        prefix: Object-name prefix, ends with ``/`` unless at the root.

    Returns:
        Folder entries for sub-prefixes and file entries for importable objects.
    """
    body = get_json(
        f"{API_URL}/b/{quote(bucket, safe='')}/o",
        provider=PROVIDER,
        headers=headers,
        params={
            "prefix": prefix,
            "delimiter": "/",
            "fields": "items(name,size,updated),prefixes",
            "maxResults": LIST_LIMIT,
        },
    )
    folders = [
        Entry(ref=f"{bucket}/{p}", name=p[len(prefix) :].rstrip("/"), kind="folder")
        for p in body.get("prefixes") or []
        if isinstance(p, str)
    ]
    files: list[Entry] = []
    for item in body.get("items") or []:
        name = item.get("name")
        if not isinstance(name, str) or name == prefix or not is_supported(name):
            continue
        size = str(item.get("size") or "")
        files.append(
            Entry(
                ref=f"{bucket}/{name}",
                name=name[len(prefix) :],
                kind="file",
                size=int(size) if size.isdigit() else None,
                modified=item.get("updated"),
            )
        )
    return folders + files


def verify_credentials(fields: dict[str, str]) -> Credential:
    """Validate a service-account key by listing buckets (or the pinned bucket).

    Args:
        fields: ``service_account_json`` and the optional ``bucket``.

    Returns:
        The credential to store, labelled with the service account's e-mail
        (and the bucket when pinned).

    Raises:
        DomainError: 400 when the key is malformed or Google rejects it.
    """
    key = parse_service_account(fields.get("service_account_json", ""))
    bucket = fields.get("bucket", "").strip()
    config = {"service_account": key, "bucket": bucket}
    headers = _headers(config)
    try:
        if bucket:
            _list_objects(headers, bucket, "")
        else:
            _list_buckets(headers, key.get("project_id") or "")
    except DomainError as exc:
        if exc.code in ("connectors.rejected", "connectors.not_found"):
            raise DomainError("connectors.invalid_credentials", status=400) from exc
        raise
    label = f"{key['client_email']} · {bucket}" if bucket else key["client_email"]
    return Credential(secret=json.dumps(config), auth_method="service_account", account_label=label)


def browse(secret: ConnectorSecret, location: str, search: str) -> list[Entry]:
    """List buckets (or, for a user account, projects) at the root, or one prefix of a bucket.

    Args:
        secret: The stored connector.
        location: Empty for the root, ``project:<id>`` for a project's
            buckets, else ``bucket/prefix/``.
        search: Substring filter applied to the listing.

    Returns:
        The entries.
    """
    headers = _secret_headers(secret)
    if not location and secret.auth_method == "oauth":
        entries = _list_projects(headers)
    elif not location:
        config = _config(secret)
        if config.get("bucket"):
            entries = [Entry(ref=config["bucket"], name=config["bucket"], kind="folder")]
        else:
            entries = _list_buckets(headers, config["service_account"].get("project_id") or "")
    elif location.startswith(PROJECT_PREFIX):
        entries = _list_buckets(headers, location.removeprefix(PROJECT_PREFIX))
    else:
        bucket, prefix = split_location(location)
        entries = _list_objects(headers, bucket, prefix)
    needle = search.strip().lower()
    return [e for e in entries if needle in e.name.lower()] if needle else entries


def _split_ref(ref: str) -> tuple[str, str]:
    """Split ``bucket/name`` and refuse refs without an object name.

    Args:
        ref: A file ref.

    Returns:
        ``(bucket, name)``.

    Raises:
        DomainError: 400 when the ref has no object part.
    """
    bucket, name = split_location(ref)
    if not bucket or not name or name.endswith("/"):
        raise DomainError("connectors.invalid_ref", status=400)
    return bucket, name


def _object_url(bucket: str, name: str) -> str:
    """Build the JSON-API URL of one object.

    Args:
        bucket: Bucket name.
        name: Object name.

    Returns:
        The metadata URL; add ``alt=media`` to download.
    """
    return f"{API_URL}/b/{quote(bucket, safe='')}/o/{quote(name, safe='')}"


def _fetcher(headers: dict[str, str], bucket: str, name: str) -> Fetch:
    """Build the download closure for one object.

    Args:
        headers: Bearer headers.
        bucket: Bucket name.
        name: Object name.

    Returns:
        A callable taking an optional byte cap and returning ``(bytes, truncated)``.
    """
    url = _object_url(bucket, name)

    def fetch(max_bytes: int | None) -> tuple[bytes, bool]:
        """Download the object, honouring the cap.

        Args:
            max_bytes: Byte cap for previews, ``None`` for the whole object.

        Returns:
            ``(content, truncated)``.
        """
        return download(
            url,
            provider=PROVIDER,
            headers={**headers, **range_header(max_bytes)},
            max_bytes=max_bytes,
            params={"alt": "media"},
        )

    return fetch


def preview(secret: ConnectorSecret, ref: str) -> dict[str, Any]:
    """Decode the first rows of an object.

    Args:
        secret: The stored connector.
        ref: ``bucket/name``.

    Returns:
        ``{"columns": [...], "rows": [...], "num_rows_total": None}``.
    """
    bucket, name = _split_ref(ref)
    return preview_file(_fetcher(_secret_headers(secret), bucket, name), name)


def import_ref(secret: ConnectorSecret, ref: str) -> tuple[list[dict[str, Any]], dict[str, Any], str]:
    """Download an object and decode every row.

    Args:
        secret: The stored connector.
        ref: ``bucket/name``.

    Returns:
        ``(rows, column_schema, default_name)``.
    """
    bucket, name = _split_ref(ref)
    headers = _secret_headers(secret)
    meta = get_json(_object_url(bucket, name), provider=PROVIDER, headers=headers, params={"fields": "size"})
    size = str(meta.get("size") or "") if isinstance(meta, dict) else ""
    check_size(int(size) if size.isdigit() else None)
    rows, schema = import_file(_fetcher(headers, bucket, name), name)
    return rows, schema, name.rsplit("/", 1)[-1]
