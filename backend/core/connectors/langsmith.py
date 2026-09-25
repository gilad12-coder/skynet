"""LangSmith connector: import a project's runs or a dataset's examples.

Linking takes an API key (and the endpoint for the EU region or a
self-hosted deployment). Browsing lists tracing projects, each opening into
its root runs and its LLM runs, alongside datasets; importing walks the
paginated query endpoints and flattens ``inputs``/``outputs`` into columns.
"""

from __future__ import annotations

import json
from typing import Any
from urllib.parse import quote

from ..api.errors import DomainError
from .base import Credential, Entry
from .records import PREVIEW_ROWS, flatten, import_payload, preview_payload, row_cap
from .transport import get_json, post_json
from .vault import ConnectorSecret

PROVIDER = "langsmith"
DEFAULT_ENDPOINT = "https://api.smith.langchain.com"
PAGE_SIZE = 100
LIST_LIMIT = 100
RUN_FIELDS = (
    "id",
    "start_time",
    "end_time",
    "name",
    "run_type",
    "inputs",
    "outputs",
    "error",
    "total_tokens",
    "total_cost",
    "feedback_stats",
    "tags",
)
EXAMPLE_FIELDS = ("id", "created_at", "inputs", "outputs", "metadata", "split")


def _config(secret: ConnectorSecret) -> tuple[str, dict[str, str]]:
    """Unpack the stored credential.

    Args:
        secret: The vault entry.

    Returns:
        ``(endpoint, headers)``.
    """
    config = json.loads(secret.access_token)
    return config["endpoint"], _headers(config["api_key"])


def _headers(api_key: str) -> dict[str, str]:
    """Auth headers for the LangSmith API.

    Args:
        api_key: The API key.

    Returns:
        The headers.
    """
    return {"x-api-key": api_key, "Accept": "application/json"}


def _endpoint_url(raw: str) -> str:
    """Normalise the endpoint field.

    Args:
        raw: The pasted endpoint, possibly empty.

    Returns:
        An origin without a trailing slash.
    """
    endpoint = raw.strip().rstrip("/") or DEFAULT_ENDPOINT
    return endpoint if endpoint.startswith(("http://", "https://")) else f"https://{endpoint}"


def verify_credentials(fields: dict[str, str]) -> Credential:
    """Validate an API key by listing one project with it.

    Args:
        fields: ``{"api_key": ..., "endpoint": ...}``.

    Returns:
        The credential to store, labelled with the workspace name when known.

    Raises:
        DomainError: 400 when LangSmith rejects the key.
    """
    api_key = fields.get("api_key", "").strip()
    if not api_key:
        raise DomainError("connectors.invalid_credentials", status=400)
    endpoint = _endpoint_url(fields.get("endpoint", ""))
    headers = _headers(api_key)
    try:
        get_json(f"{endpoint}/api/v1/sessions", provider=PROVIDER, headers=headers, params={"limit": 1})
    except DomainError as exc:
        if exc.code == "connectors.rejected":
            raise DomainError("connectors.invalid_credentials", status=400) from exc
        raise
    label: str | None = None
    try:
        tenant = get_json(f"{endpoint}/api/v1/tenants/current", provider=PROVIDER, headers=headers)
        name = tenant.get("display_name") if isinstance(tenant, dict) else None
        label = name if isinstance(name, str) else None
    except DomainError:
        label = None
    secret = json.dumps({"endpoint": endpoint, "api_key": api_key})
    return Credential(secret=secret, auth_method="token", account_label=label)


def _list_root(endpoint: str, headers: dict[str, str], search: str) -> list[Entry]:
    """List tracing projects (folders) and datasets (files).

    Args:
        endpoint: API origin.
        headers: Auth headers.
        search: Name filter.

    Returns:
        The entries.
    """
    params: dict[str, Any] = {"limit": LIST_LIMIT}
    if search.strip():
        params["name_contains"] = search.strip()
    projects = get_json(f"{endpoint}/api/v1/sessions", provider=PROVIDER, headers=headers, params=params)
    datasets = get_json(f"{endpoint}/api/v1/datasets", provider=PROVIDER, headers=headers, params=params)
    entries = [
        Entry(
            ref=f"project/{p['id']}",
            name=p.get("name") or p["id"],
            kind="folder",
            modified=p.get("last_run_start_time"),
        )
        for p in (projects if isinstance(projects, list) else [])
        if isinstance(p.get("id"), str)
    ]
    entries += [
        Entry(
            ref=f"dataset/{d['id']}",
            name=d.get("name") or d["id"],
            kind="file",
            size=d.get("example_count"),
            modified=d.get("modified_at"),
        )
        for d in (datasets if isinstance(datasets, list) else [])
        if isinstance(d.get("id"), str)
    ]
    return entries


def browse(secret: ConnectorSecret, location: str, search: str) -> list[Entry]:
    """List projects and datasets at the root, or one project's run views.

    Args:
        secret: The stored connector.
        location: Empty for the root, else ``project/<id>``.
        search: Name filter, honoured at the root.

    Returns:
        The entries.
    """
    endpoint, headers = _config(secret)
    if not location:
        return _list_root(endpoint, headers, search)
    kind, _, project_id = location.partition("/")
    if kind != "project" or not project_id:
        raise DomainError("connectors.invalid_ref", status=400)
    return [
        Entry(ref=f"project/{project_id}/runs", name="Root runs", kind="file"),
        Entry(ref=f"project/{project_id}/llm", name="LLM runs", kind="file"),
    ]


def _query_runs(endpoint: str, headers: dict[str, str], project_id: str, llm_only: bool, limit: int) -> list[dict]:
    """Page through a project's runs.

    Args:
        endpoint: API origin.
        headers: Auth headers.
        project_id: The tracing project.
        llm_only: Restrict to ``llm`` runs instead of root runs.
        limit: Row cap.

    Returns:
        The flattened rows.
    """
    rows: list[dict[str, Any]] = []
    cursor: str | None = None
    while len(rows) < limit:
        body: dict[str, Any] = {
            "session": [project_id],
            "limit": min(PAGE_SIZE, limit - len(rows)),
            "select": list(RUN_FIELDS),
            "order": "desc",
        }
        if llm_only:
            body["run_type"] = "llm"
        else:
            body["is_root"] = True
        if cursor:
            body["cursor"] = cursor
        page = post_json(f"{endpoint}/api/v1/runs/query", provider=PROVIDER, headers=headers, body=body)
        runs = page.get("runs") if isinstance(page, dict) else None
        if not isinstance(runs, list) or not runs:
            break
        rows.extend(flatten(run, RUN_FIELDS) for run in runs if isinstance(run, dict))
        cursor = (page.get("cursors") or {}).get("next")
        if not cursor:
            break
    return rows


def _list_examples(endpoint: str, headers: dict[str, str], dataset_id: str, limit: int) -> list[dict[str, Any]]:
    """Page through a dataset's examples.

    Args:
        endpoint: API origin.
        headers: Auth headers.
        dataset_id: The dataset.
        limit: Row cap.

    Returns:
        The flattened rows.
    """
    rows: list[dict[str, Any]] = []
    while len(rows) < limit:
        page = get_json(
            f"{endpoint}/api/v1/examples",
            provider=PROVIDER,
            headers=headers,
            params={"dataset": dataset_id, "limit": min(PAGE_SIZE, limit - len(rows)), "offset": len(rows)},
        )
        if not isinstance(page, list) or not page:
            break
        rows.extend(flatten(example, EXAMPLE_FIELDS) for example in page if isinstance(example, dict))
        if len(page) < PAGE_SIZE:
            break
    return rows


def _fetch(secret: ConnectorSecret, ref: str, limit: int) -> tuple[list[dict[str, Any]], str]:
    """Resolve a ref and read up to ``limit`` rows from it.

    Args:
        secret: The stored connector.
        ref: ``project/<id>/runs``, ``project/<id>/llm`` or ``dataset/<id>``.
        limit: Row cap.

    Returns:
        ``(rows, default_name)``.

    Raises:
        DomainError: 400 for an unknown ref shape.
    """
    endpoint, headers = _config(secret)
    parts = ref.split("/")
    if len(parts) == 3 and parts[0] == "project" and parts[1] and parts[2] in {"runs", "llm"}:
        return _query_runs(endpoint, headers, parts[1], parts[2] == "llm", limit), f"langsmith-{parts[2]}"
    if len(parts) == 2 and parts[0] == "dataset" and parts[1]:
        return _list_examples(endpoint, headers, parts[1], limit), f"langsmith-dataset-{quote(parts[1], safe='')}"
    raise DomainError("connectors.invalid_ref", status=400)


def preview(secret: ConnectorSecret, ref: str) -> dict[str, Any]:
    """Read the first records behind a ref.

    Args:
        secret: The stored connector.
        ref: A file ref from :func:`browse`.

    Returns:
        The preview envelope.
    """
    rows, _ = _fetch(secret, ref, PREVIEW_ROWS)
    return preview_payload(rows)


def import_ref(secret: ConnectorSecret, ref: str) -> tuple[list[dict[str, Any]], dict[str, Any], str]:
    """Read every record behind a ref, up to the row cap.

    Args:
        secret: The stored connector.
        ref: A file ref from :func:`browse`.

    Returns:
        ``(rows, column_schema, default_name)``.
    """
    rows, name = _fetch(secret, ref, row_cap())
    return rows, import_payload(rows), name
