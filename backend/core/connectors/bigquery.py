"""BigQuery connector: import a table or view with a service-account key.

Browsing lists the project's datasets, then the tables and views of one
dataset. Tables are read through ``tabledata.list``, which is free of query
charges; views have no stored rows, so they go through a ``SELECT`` job.
"""

from __future__ import annotations

import json
import re
from typing import Any
from urllib.parse import quote

from ..api.errors import DomainError
from .base import Credential, Entry
from .google_auth import parse_service_account, service_account_token
from .records import PREVIEW_ROWS, cell, import_payload, preview_payload, row_cap
from .transport import get_json, label, post_json
from .vault import ConnectorSecret

PROVIDER = "bigquery"
API_URL = "https://bigquery.googleapis.com/bigquery/v2/projects"
SCOPES = "https://www.googleapis.com/auth/bigquery.readonly"
LIST_LIMIT = 200
PAGE_SIZE = 1000
QUERY_TIMEOUT_MS = 30000
IDENTIFIER = re.compile(r"^[\w$-]+$")


def _config(secret: ConnectorSecret) -> tuple[str, dict[str, str]]:
    """Resolve the project and a bearer token from the stored key.

    Args:
        secret: The vault entry.

    Returns:
        ``(project, headers)``.
    """
    config = json.loads(secret.access_token)
    token = service_account_token(config["service_account"], SCOPES, PROVIDER)
    return config["project"], {"Authorization": f"Bearer {token}", "Accept": "application/json"}


def verify_credentials(fields: dict[str, str]) -> Credential:
    """Validate a key by listing the project's datasets with it.

    Args:
        fields: ``{"service_account_json": ..., "project": ...}``; the project
            defaults to the key's own.

    Returns:
        The credential to store, labelled ``email (project)``.

    Raises:
        DomainError: 400 when the key is malformed or lacks a project.
    """
    key = parse_service_account(fields.get("service_account_json", ""))
    project = fields.get("project", "").strip() or key.get("project_id", "")
    if not project or not IDENTIFIER.match(project):
        raise DomainError("connectors.invalid_credentials", status=400)
    token = service_account_token(key, SCOPES, PROVIDER)
    get_json(
        f"{API_URL}/{quote(project, safe='')}/datasets",
        provider=PROVIDER,
        headers={"Authorization": f"Bearer {token}"},
        params={"maxResults": 1},
    )
    secret = json.dumps({"service_account": key, "project": project})
    return Credential(secret=secret, auth_method="service_account", account_label=f"{key['client_email']} ({project})")


def _split_ref(ref: str) -> tuple[str, str]:
    """Split ``dataset.table`` and reject anything that is not an identifier.

    Args:
        ref: A file ref from :func:`browse`.

    Returns:
        ``(dataset, table)``.

    Raises:
        DomainError: 400 for a malformed ref.
    """
    dataset, _, table = ref.partition(".")
    if not IDENTIFIER.match(dataset or "") or not IDENTIFIER.match(table or ""):
        raise DomainError("connectors.invalid_ref", status=400)
    return dataset, table


def browse(secret: ConnectorSecret, location: str, search: str) -> list[Entry]:
    """List datasets at the root, or the tables and views of one dataset.

    Args:
        secret: The stored connector.
        location: Empty for the root, else a dataset id.
        search: Name filter.

    Returns:
        The entries.
    """
    project, headers = _config(secret)
    needle = search.strip().lower()
    if not location:
        body = get_json(
            f"{API_URL}/{quote(project, safe='')}/datasets",
            provider=PROVIDER,
            headers=headers,
            params={"maxResults": LIST_LIMIT},
        )
        ids = [
            d["datasetReference"]["datasetId"]
            for d in (body.get("datasets") if isinstance(body, dict) else None) or []
            if isinstance((d.get("datasetReference") or {}).get("datasetId"), str)
        ]
        return [Entry(ref=i, name=i, kind="folder") for i in ids if needle in i.lower()]
    if not IDENTIFIER.match(location):
        raise DomainError("connectors.invalid_ref", status=400)
    body = get_json(
        f"{API_URL}/{quote(project, safe='')}/datasets/{quote(location, safe='')}/tables",
        provider=PROVIDER,
        headers=headers,
        params={"maxResults": LIST_LIMIT},
    )
    entries: list[Entry] = []
    for t in (body.get("tables") if isinstance(body, dict) else None) or []:
        table_id = (t.get("tableReference") or {}).get("tableId")
        if not isinstance(table_id, str) or needle not in table_id.lower():
            continue
        modified = t.get("creationTime")
        entries.append(Entry(ref=f"{location}.{table_id}", name=table_id, kind="file", modified=modified))
    return entries


def _decode(value: Any, field: dict[str, Any]) -> Any:
    """Decode one cell of the ``{"f": [{"v": ...}]}`` row encoding.

    Args:
        value: The ``v`` payload.
        field: The schema field describing it.

    Returns:
        A JSON-safe scalar.
    """
    if value is None:
        return None
    if field.get("mode") == "REPEATED":
        inner = {**field, "mode": "NULLABLE"}
        return cell([_decode(item.get("v") if isinstance(item, dict) else item, inner) for item in value])
    kind = field.get("type")
    if kind in {"RECORD", "STRUCT"} and isinstance(value, dict):
        subfields = field.get("fields") or []
        nested = {
            sf.get("name"): _decode(v.get("v"), sf) for sf, v in zip(subfields, value.get("f") or [], strict=False)
        }
        return cell(nested)
    if kind in {"INTEGER", "INT64"}:
        return int(value)
    if kind in {"FLOAT", "FLOAT64"}:
        return float(value)
    if kind in {"BOOLEAN", "BOOL"}:
        return value in (True, "true", "TRUE")
    return value if isinstance(value, str | int | float | bool) else cell(value)


def _decode_rows(rows: Any, fields: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Decode a page of rows against the schema.

    Args:
        rows: The API's ``rows`` list.
        fields: The schema fields.

    Returns:
        Row dicts keyed by column name.
    """
    decoded: list[dict[str, Any]] = []
    for row in rows if isinstance(rows, list) else []:
        cells = row.get("f") or []
        decoded.append(
            {
                f["name"]: _decode(c.get("v") if isinstance(c, dict) else None, f)
                for f, c in zip(fields, cells, strict=False)
            }
        )
    return decoded


def _table_meta(project: str, headers: dict[str, str], dataset: str, table: str) -> tuple[list[dict[str, Any]], str]:
    """Read a table's schema and type.

    Args:
        project: The project.
        headers: Auth headers.
        dataset: Dataset id.
        table: Table id.

    Returns:
        ``(schema_fields, table_type)``.
    """
    body = get_json(
        f"{API_URL}/{quote(project, safe='')}/datasets/{quote(dataset, safe='')}/tables/{quote(table, safe='')}",
        provider=PROVIDER,
        headers=headers,
        params={"selectedFields": "schema,type"},
    )
    fields = (body.get("schema") or {}).get("fields") if isinstance(body, dict) else None
    return list(fields or []), str(body.get("type") or "TABLE") if isinstance(body, dict) else "TABLE"


def _list_tabledata(
    project: str, headers: dict[str, str], dataset: str, table: str, fields: list[dict[str, Any]], limit: int
) -> list[dict[str, Any]]:
    """Read stored rows through ``tabledata.list``.

    Args:
        project: The project.
        headers: Auth headers.
        dataset: Dataset id.
        table: Table id.
        fields: Schema fields.
        limit: Row cap.

    Returns:
        The rows.
    """
    url = f"{API_URL}/{quote(project, safe='')}/datasets/{quote(dataset, safe='')}/tables/{quote(table, safe='')}/data"
    rows: list[dict[str, Any]] = []
    token: str | None = None
    while len(rows) < limit:
        params: dict[str, Any] = {"maxResults": min(PAGE_SIZE, limit - len(rows))}
        if token:
            params["pageToken"] = token
        page = get_json(url, provider=PROVIDER, headers=headers, params=params)
        rows.extend(_decode_rows(page.get("rows"), fields))
        token = page.get("pageToken")
        if not token:
            break
    return rows


def _query(
    project: str, headers: dict[str, str], dataset: str, table: str, limit: int
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """Read a view through a ``SELECT`` job, waiting for it to finish.

    Args:
        project: The project.
        headers: Auth headers.
        dataset: Dataset id.
        table: View id.
        limit: Row cap.

    Returns:
        ``(rows, schema_fields)``.
    """
    base = f"{API_URL}/{quote(project, safe='')}/queries"
    page = post_json(
        base,
        provider=PROVIDER,
        headers=headers,
        body={
            "query": f"SELECT * FROM `{project}.{dataset}.{table}` LIMIT {limit}",
            "useLegacySql": False,
            "maxResults": min(PAGE_SIZE, limit),
            "timeoutMs": QUERY_TIMEOUT_MS,
        },
    )
    job = page.get("jobReference") or {}
    params: dict[str, Any] = {"maxResults": min(PAGE_SIZE, limit), "timeoutMs": QUERY_TIMEOUT_MS}
    if job.get("location"):
        params["location"] = job["location"]
    while not page.get("jobComplete"):
        if not job.get("jobId"):
            raise DomainError("connectors.provider_error", status=502, provider=label(PROVIDER), status_code=200)
        page = get_json(f"{base}/{quote(job['jobId'], safe='')}", provider=PROVIDER, headers=headers, params=params)
    fields = list((page.get("schema") or {}).get("fields") or [])
    rows = _decode_rows(page.get("rows"), fields)
    token = page.get("pageToken")
    while token and len(rows) < limit:
        page = get_json(
            f"{base}/{quote(job['jobId'], safe='')}",
            provider=PROVIDER,
            headers=headers,
            params={**params, "pageToken": token},
        )
        rows.extend(_decode_rows(page.get("rows"), fields))
        token = page.get("pageToken")
    return rows[:limit], fields


def _read(secret: ConnectorSecret, ref: str, limit: int) -> tuple[list[dict[str, Any]], list[str]]:
    """Read the first ``limit`` rows behind a ref.

    Args:
        secret: The stored connector.
        ref: ``dataset.table``.
        limit: Row cap.

    Returns:
        ``(rows, column_names)``.
    """
    dataset, table = _split_ref(ref)
    project, headers = _config(secret)
    fields, kind = _table_meta(project, headers, dataset, table)
    if kind == "TABLE" and fields:
        rows = _list_tabledata(project, headers, dataset, table, fields, limit)
    else:
        rows, fields = _query(project, headers, dataset, table, limit)
    return rows, [f["name"] for f in fields if isinstance(f.get("name"), str)]


def preview(secret: ConnectorSecret, ref: str) -> dict[str, Any]:
    """Read the first rows of a table or view.

    Args:
        secret: The stored connector.
        ref: ``dataset.table``.

    Returns:
        The preview envelope.
    """
    rows, columns = _read(secret, ref, PREVIEW_ROWS)
    return preview_payload(rows, columns)


def import_ref(secret: ConnectorSecret, ref: str) -> tuple[list[dict[str, Any]], dict[str, Any], str]:
    """Read a table or view into library rows, up to the row cap.

    Args:
        secret: The stored connector.
        ref: ``dataset.table``.

    Returns:
        ``(rows, column_schema, default_name)``.
    """
    rows, columns = _read(secret, ref, row_cap())
    return rows, import_payload(rows, columns), _split_ref(ref)[1]
