"""Google Cloud Storage connector.

Credentials are a service-account key, optionally pinned to one bucket.
Tokens are minted with the read-only storage scope and the JSON API is used
directly, so no Google client library is needed for the three calls involved:
list buckets, list objects, download an object.
"""

from __future__ import annotations

import json
from typing import Any
from urllib.parse import quote

from ..api.errors import DomainError
from .base import Credential, Entry, Fetch, import_file, preview_file, range_header, split_location
from .google_auth import parse_service_account, service_account_token
from .tabular import check_size, is_supported
from .transport import download, get_json
from .vault import ConnectorSecret

PROVIDER = "gcs"
API_URL = "https://storage.googleapis.com/storage/v1"
SCOPE = "https://www.googleapis.com/auth/devstorage.read_only"
LIST_LIMIT = 1000


def _config(secret: ConnectorSecret) -> dict[str, Any]:
    """Decode the stored credential JSON.

    Args:
        secret: The vault entry.

    Returns:
        ``{"service_account": {...}, "bucket": str}``.
    """
    return json.loads(secret.access_token)


def _headers(config: dict[str, Any]) -> dict[str, str]:
    """Mint a bearer token for the stored service account.

    Args:
        config: Decoded credentials.

    Returns:
        The request headers.
    """
    token = service_account_token(config["service_account"], SCOPE, PROVIDER)
    return {"Authorization": f"Bearer {token}", "Accept": "application/json"}


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
    """List buckets at the root, or one prefix of a bucket.

    Args:
        secret: The stored connector.
        location: Empty for the root, else ``bucket/prefix/``.
        search: Substring filter applied to the listing.

    Returns:
        The entries.
    """
    config = _config(secret)
    headers = _headers(config)
    if not location:
        if config.get("bucket"):
            entries = [Entry(ref=config["bucket"], name=config["bucket"], kind="folder")]
        else:
            entries = _list_buckets(headers, config["service_account"].get("project_id") or "")
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
    return preview_file(_fetcher(_headers(_config(secret)), bucket, name), name)


def import_ref(secret: ConnectorSecret, ref: str) -> tuple[list[dict[str, Any]], dict[str, Any], str]:
    """Download an object and decode every row.

    Args:
        secret: The stored connector.
        ref: ``bucket/name``.

    Returns:
        ``(rows, column_schema, default_name)``.
    """
    bucket, name = _split_ref(ref)
    headers = _headers(_config(secret))
    meta = get_json(_object_url(bucket, name), provider=PROVIDER, headers=headers, params={"fields": "size"})
    size = str(meta.get("size") or "") if isinstance(meta, dict) else ""
    check_size(int(size) if size.isdigit() else None)
    rows, schema = import_file(_fetcher(headers, bucket, name), name)
    return rows, schema, name.rsplit("/", 1)[-1]
