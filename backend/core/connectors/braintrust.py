"""Braintrust connector: import a project's logs, an experiment or a dataset.

Linking takes an API key. Browsing lists projects, each opening into its
production logs, its experiments and its datasets; importing walks the
``fetch`` endpoints with their cursor and flattens ``input``/``output``/
``expected``/``scores`` into columns.
"""

from __future__ import annotations

from typing import Any
from urllib.parse import quote

from ..api.errors import DomainError
from .base import Credential, Entry
from .records import PREVIEW_ROWS, flatten, import_payload, preview_payload, row_cap
from .transport import get_json
from .vault import ConnectorSecret

PROVIDER = "braintrust"
API_URL = "https://api.braintrust.dev/v1"
PAGE_SIZE = 100
LIST_LIMIT = 100
EVENT_FIELDS = ("id", "created", "input", "output", "expected", "scores", "metadata", "error", "metrics", "tags")


def _headers(api_key: str) -> dict[str, str]:
    """Bearer headers for the Braintrust API.

    Args:
        api_key: The API key.

    Returns:
        The headers.
    """
    return {"Authorization": f"Bearer {api_key}", "Accept": "application/json"}


def _objects(body: Any) -> list[dict[str, Any]]:
    """Unwrap a list response.

    Args:
        body: The decoded reply.

    Returns:
        The ``objects`` list, or empty.
    """
    objects = body.get("objects") if isinstance(body, dict) else None
    return [o for o in objects if isinstance(o, dict)] if isinstance(objects, list) else []


def verify_credentials(fields: dict[str, str]) -> Credential:
    """Validate an API key by listing one project with it.

    Args:
        fields: ``{"api_key": ...}``.

    Returns:
        The credential to store, labelled with the organisation name when known.

    Raises:
        DomainError: 400 when Braintrust rejects the key.
    """
    api_key = fields.get("api_key", "").strip()
    if not api_key:
        raise DomainError("connectors.invalid_credentials", status=400)
    headers = _headers(api_key)
    try:
        get_json(f"{API_URL}/project", provider=PROVIDER, headers=headers, params={"limit": 1})
    except DomainError as exc:
        if exc.code == "connectors.rejected":
            raise DomainError("connectors.invalid_credentials", status=400) from exc
        raise
    label: str | None = None
    try:
        orgs = _objects(get_json(f"{API_URL}/organization", provider=PROVIDER, headers=headers, params={"limit": 1}))
        name = orgs[0].get("name") if orgs else None
        label = name if isinstance(name, str) else None
    except DomainError:
        label = None
    return Credential(secret=api_key, auth_method="token", account_label=label)


def _list_projects(headers: dict[str, str], search: str) -> list[Entry]:
    """List projects, newest first.

    Args:
        headers: Auth headers.
        search: Name filter.

    Returns:
        Folder entries keyed ``project/<id>``.
    """
    body = get_json(f"{API_URL}/project", provider=PROVIDER, headers=headers, params={"limit": LIST_LIMIT})
    needle = search.strip().lower()
    return [
        Entry(ref=f"project/{p['id']}", name=p.get("name") or p["id"], kind="folder", modified=p.get("created"))
        for p in _objects(body)
        if isinstance(p.get("id"), str) and needle in str(p.get("name") or "").lower()
    ]


def _list_project(headers: dict[str, str], project_id: str) -> list[Entry]:
    """List one project's logs, experiments and datasets.

    Args:
        headers: Auth headers.
        project_id: The project.

    Returns:
        File entries.
    """
    entries = [Entry(ref=f"project/{project_id}/logs", name="Logs", kind="file")]
    params = {"project_id": project_id, "limit": LIST_LIMIT}
    for kind in ("experiment", "dataset"):
        body = get_json(f"{API_URL}/{kind}", provider=PROVIDER, headers=headers, params=params)
        entries += [
            Entry(ref=f"{kind}/{o['id']}", name=o.get("name") or o["id"], kind="file", modified=o.get("created"))
            for o in _objects(body)
            if isinstance(o.get("id"), str)
        ]
    return entries


def browse(secret: ConnectorSecret, location: str, search: str) -> list[Entry]:
    """List projects at the root, or one project's importable collections.

    Args:
        secret: The stored connector.
        location: Empty for the root, else ``project/<id>``.
        search: Name filter, honoured at the root.

    Returns:
        The entries.
    """
    headers = _headers(secret.access_token)
    if not location:
        return _list_projects(headers, search)
    kind, _, project_id = location.partition("/")
    if kind != "project" or not project_id:
        raise DomainError("connectors.invalid_ref", status=400)
    return _list_project(headers, project_id)


def _fetch_url(ref: str) -> tuple[str, str]:
    """Resolve a ref to its ``fetch`` URL and default name.

    Args:
        ref: ``project/<id>/logs``, ``experiment/<id>`` or ``dataset/<id>``.

    Returns:
        ``(url, default_name)``.

    Raises:
        DomainError: 400 for an unknown ref shape.
    """
    parts = ref.split("/")
    if len(parts) == 3 and parts[0] == "project" and parts[1] and parts[2] == "logs":
        return f"{API_URL}/project_logs/{quote(parts[1], safe='')}/fetch", "braintrust-logs"
    if len(parts) == 2 and parts[0] in {"experiment", "dataset"} and parts[1]:
        return f"{API_URL}/{parts[0]}/{quote(parts[1], safe='')}/fetch", f"braintrust-{parts[0]}"
    raise DomainError("connectors.invalid_ref", status=400)


def _fetch(secret: ConnectorSecret, ref: str, limit: int) -> tuple[list[dict[str, Any]], str]:
    """Page through a collection up to ``limit`` events.

    Args:
        secret: The stored connector.
        ref: A file ref from :func:`browse`.
        limit: Row cap.

    Returns:
        ``(rows, default_name)``.
    """
    url, name = _fetch_url(ref)
    headers = _headers(secret.access_token)
    rows: list[dict[str, Any]] = []
    cursor: str | None = None
    while len(rows) < limit:
        params: dict[str, Any] = {"limit": min(PAGE_SIZE, limit - len(rows))}
        if cursor:
            params["cursor"] = cursor
        page = get_json(url, provider=PROVIDER, headers=headers, params=params)
        events = page.get("events") if isinstance(page, dict) else None
        if not isinstance(events, list) or not events:
            break
        rows.extend(flatten(event, EVENT_FIELDS) for event in events if isinstance(event, dict))
        cursor = page.get("cursor")
        if not cursor:
            break
    return rows, name


def preview(secret: ConnectorSecret, ref: str) -> dict[str, Any]:
    """Read the first events behind a ref.

    Args:
        secret: The stored connector.
        ref: A file ref from :func:`browse`.

    Returns:
        The preview envelope.
    """
    rows, _ = _fetch(secret, ref, PREVIEW_ROWS)
    return preview_payload(rows)


def import_ref(secret: ConnectorSecret, ref: str) -> tuple[list[dict[str, Any]], dict[str, Any], str]:
    """Read every event behind a ref, up to the row cap.

    Args:
        secret: The stored connector.
        ref: A file ref from :func:`browse`.

    Returns:
        ``(rows, column_schema, default_name)``.
    """
    rows, name = _fetch(secret, ref, row_cap())
    return rows, import_payload(rows), name
