"""Langfuse connector: import traces, generations and dataset items.

Linking takes a project's public/secret key pair (and the host for a
self-hosted or EU deployment). Browsing offers the project's traces, its LLM
generations and each of its datasets; importing walks the public API in
pages, flattening every record's ``input``/``output`` into columns.
"""

from __future__ import annotations

import base64
import json
from typing import Any
from urllib.parse import quote

from ..api.errors import DomainError
from .base import Credential, Entry
from .records import PREVIEW_ROWS, flatten, import_payload, preview_payload, row_cap
from .transport import get_json
from .vault import ConnectorSecret

PROVIDER = "langfuse"
DEFAULT_HOST = "https://cloud.langfuse.com"
PAGE_SIZE = 100
TRACE_FIELDS = (
    "id",
    "timestamp",
    "name",
    "userId",
    "sessionId",
    "input",
    "output",
    "tags",
    "metadata",
    "latency",
    "totalCost",
)
GENERATION_FIELDS = (
    "id",
    "startTime",
    "traceId",
    "name",
    "model",
    "input",
    "output",
    "usage",
    "level",
    "statusMessage",
    "latency",
    "calculatedTotalCost",
)
DATASET_ITEM_FIELDS = ("id", "input", "expectedOutput", "metadata", "sourceTraceId", "status")


def _config(secret: ConnectorSecret) -> tuple[str, dict[str, str]]:
    """Unpack the stored credential.

    Args:
        secret: The vault entry.

    Returns:
        ``(host, headers)``.
    """
    config = json.loads(secret.access_token)
    return config["host"], _headers(config["public_key"], config["secret_key"])


def _headers(public_key: str, secret_key: str) -> dict[str, str]:
    """Basic-auth headers for the Langfuse public API.

    Args:
        public_key: Project public key.
        secret_key: Project secret key.

    Returns:
        The headers.
    """
    token = base64.b64encode(f"{public_key}:{secret_key}".encode()).decode("ascii")
    return {"Authorization": f"Basic {token}", "Accept": "application/json"}


def _host(raw: str) -> str:
    """Normalise the host field.

    Args:
        raw: The pasted host, possibly empty.

    Returns:
        An ``https://`` origin without a trailing slash.
    """
    host = raw.strip().rstrip("/") or DEFAULT_HOST
    return host if host.startswith(("http://", "https://")) else f"https://{host}"


def verify_credentials(fields: dict[str, str]) -> Credential:
    """Validate a key pair by listing the projects it can see.

    Args:
        fields: ``{"public_key": ..., "secret_key": ..., "host": ...}``.

    Returns:
        The credential to store, labelled with the project name.

    Raises:
        DomainError: 400 when Langfuse rejects the pair.
    """
    public_key = fields.get("public_key", "").strip()
    secret_key = fields.get("secret_key", "").strip()
    if not public_key or not secret_key:
        raise DomainError("connectors.invalid_credentials", status=400)
    host = _host(fields.get("host", ""))
    try:
        body = get_json(f"{host}/api/public/projects", provider=PROVIDER, headers=_headers(public_key, secret_key))
    except DomainError as exc:
        if exc.code == "connectors.rejected":
            raise DomainError("connectors.invalid_credentials", status=400) from exc
        raise
    projects = body.get("data") if isinstance(body, dict) else None
    name = projects[0].get("name") if isinstance(projects, list) and projects else None
    secret = json.dumps({"host": host, "public_key": public_key, "secret_key": secret_key})
    return Credential(secret=secret, auth_method="credentials", account_label=name if isinstance(name, str) else None)


def browse(secret: ConnectorSecret, location: str, search: str) -> list[Entry]:
    """List the importable collections: traces, generations and datasets.

    Args:
        secret: The stored connector.
        location: Ignored; the listing is flat.
        search: Name filter.

    Returns:
        File entries.
    """
    host, headers = _config(secret)
    entries = [
        Entry(ref="traces", name="Traces", kind="file"),
        Entry(ref="generations", name="Generations", kind="file"),
    ]
    body = get_json(f"{host}/api/public/v2/datasets", provider=PROVIDER, headers=headers, params={"limit": PAGE_SIZE})
    for dataset in (body.get("data") if isinstance(body, dict) else None) or []:
        name = dataset.get("name")
        if isinstance(name, str):
            entries.append(Entry(ref=f"dataset/{name}", name=name, kind="file", modified=dataset.get("updatedAt")))
    needle = search.strip().lower()
    return [e for e in entries if needle in e.name.lower()] if needle else entries


def _endpoint(ref: str) -> tuple[str, dict[str, Any], tuple[str, ...], str]:
    """Resolve a ref to its API path, fixed params, columns and default name.

    Args:
        ref: A file ref from :func:`browse`.

    Returns:
        ``(path, params, fields, default_name)``.

    Raises:
        DomainError: 400 for an unknown ref.
    """
    if ref == "traces":
        return "/api/public/traces", {}, TRACE_FIELDS, "langfuse-traces"
    if ref == "generations":
        return "/api/public/observations", {"type": "GENERATION"}, GENERATION_FIELDS, "langfuse-generations"
    kind, _, name = ref.partition("/")
    if kind == "dataset" and name:
        return "/api/public/dataset-items", {"datasetName": name}, DATASET_ITEM_FIELDS, name
    raise DomainError("connectors.invalid_ref", status=400)


def _fetch(secret: ConnectorSecret, ref: str, limit: int) -> tuple[list[dict[str, Any]], str]:
    """Page through a collection up to ``limit`` rows.

    Args:
        secret: The stored connector.
        ref: The collection ref.
        limit: Row cap.

    Returns:
        ``(rows, default_name)``.
    """
    host, headers = _config(secret)
    path, params, fields, name = _endpoint(ref)
    rows: list[dict[str, Any]] = []
    page = 1
    while len(rows) < limit:
        body = get_json(
            f"{host}{path}",
            provider=PROVIDER,
            headers=headers,
            params={**params, "page": page, "limit": min(PAGE_SIZE, limit - len(rows))},
        )
        data = body.get("data") if isinstance(body, dict) else None
        if not isinstance(data, list) or not data:
            break
        rows.extend(flatten(item, fields) for item in data if isinstance(item, dict))
        meta = body.get("meta") or {}
        if page >= int(meta.get("totalPages") or 0):
            break
        page += 1
    return rows, quote(name, safe="")


def preview(secret: ConnectorSecret, ref: str) -> dict[str, Any]:
    """Read the first records of a collection.

    Args:
        secret: The stored connector.
        ref: The collection ref.

    Returns:
        The preview envelope.
    """
    rows, _ = _fetch(secret, ref, PREVIEW_ROWS)
    return preview_payload(rows)


def import_ref(secret: ConnectorSecret, ref: str) -> tuple[list[dict[str, Any]], dict[str, Any], str]:
    """Read a collection into library rows.

    Args:
        secret: The stored connector.
        ref: The collection ref.

    Returns:
        ``(rows, column_schema, default_name)``.
    """
    rows, name = _fetch(secret, ref, row_cap())
    return rows, import_payload(rows), name
