"""BigQuery connector: import a table or view.

Linking works through Google OAuth when the deployment registered a Google
OAuth client, or with a service-account key pinned to one project. A key
browses that project's datasets, then the tables and views of one dataset; a
user account has no single project, so its root lists the projects it can see
and every location and ref carries the project as a ``<project>/`` prefix.
Tables are read through ``tabledata.list``, which is free of query charges;
views have no stored rows, so they go through a ``SELECT`` job.
"""

from __future__ import annotations

import json
import re
from typing import Any
from urllib.parse import quote

from ..api.errors import DomainError
from ..config import settings
from .base import Credential, Entry
from .google_auth import parse_service_account, service_account_token
from .oauth import OAuthApp
from .oauth import oauth_available as _oauth_available
from .records import PREVIEW_ROWS, cell, import_payload, preview_payload, row_cap
from .transport import get_json, label, post_json
from .vault import ConnectorSecret

PROVIDER = "bigquery"
API_URL = "https://bigquery.googleapis.com/bigquery/v2/projects"
USERINFO_URL = "https://www.googleapis.com/oauth2/v3/userinfo"
SCOPES = "https://www.googleapis.com/auth/bigquery.readonly"
OAUTH_SCOPES = f"openid email {SCOPES}"
LIST_LIMIT = 200
PAGE_SIZE = 1000
QUERY_TIMEOUT_MS = 30000
IDENTIFIER = re.compile(r"^[\w$-]+$")
# Domain-scoped projects look like ``example.com:analytics``.
PROJECT_ID = re.compile(r"^[\w.:-]+$")


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


def _bearer_headers(token: str) -> dict[str, str]:
    """Bearer headers for the BigQuery API.

    Args:
        token: The access token.

    Returns:
        The headers.
    """
    return {"Authorization": f"Bearer {token}", "Accept": "application/json"}


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


def _project(value: str) -> str:
    """Validate a project id taken from a location or ref.

    Args:
        value: The candidate project id.

    Returns:
        The project id.

    Raises:
        DomainError: 400 when it is not a project id.
    """
    if not PROJECT_ID.match(value):
        raise DomainError("connectors.invalid_ref", status=400)
    return value


def _config(secret: ConnectorSecret, path: str) -> tuple[str, str, str, dict[str, str]]:
    """Resolve the project, the project-relative path and auth headers.

    Args:
        secret: The vault entry.
        path: A location or ref; OAuth links prefix it with ``<project>/``.

    Returns:
        ``(project, rest, prefix, headers)``: ``rest`` is ``path`` without the
        project and ``prefix`` is what new refs must start with.
    """
    if secret.auth_method == "oauth":
        project, _, rest = path.partition("/")
        return _project(project), rest, f"{project}/", _bearer_headers(secret.access_token)
    config = json.loads(secret.access_token)
    token = service_account_token(config["service_account"], SCOPES, PROVIDER)
    return config["project"], path, "", _bearer_headers(token)


def _list_projects(headers: dict[str, str], needle: str) -> list[Entry]:
    """List the projects a user account can use BigQuery in.

    Args:
        headers: Bearer headers.
        needle: Lower-cased name filter.

    Returns:
        Folder entries keyed by project id.
    """
    body = get_json(API_URL, provider=PROVIDER, headers=headers, params={"maxResults": LIST_LIMIT})
    entries: list[Entry] = []
    for p in (body.get("projects") if isinstance(body, dict) else None) or []:
        project_id = (p.get("projectReference") or {}).get("projectId")
        name = p.get("friendlyName") or project_id
        if isinstance(project_id, str) and (needle in project_id.lower() or needle in str(name).lower()):
            entries.append(Entry(ref=project_id, name=str(name), kind="folder"))
    return entries


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

    OAuth links add a level above: projects at the root, then
    ``<project>`` for its datasets and ``<project>/<dataset>`` for its tables.

    Args:
        secret: The stored connector.
        location: Empty for the root, else a dataset id (``project/dataset``
            for OAuth links).
        search: Name filter.

    Returns:
        The entries.
    """
    needle = search.strip().lower()
    if not location and secret.auth_method == "oauth":
        return _list_projects(_bearer_headers(secret.access_token), needle)
    project, location, prefix, headers = _config(secret, location)
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
        return [Entry(ref=f"{prefix}{i}", name=i, kind="folder") for i in ids if needle in i.lower()]
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
        entries.append(Entry(ref=f"{prefix}{location}.{table_id}", name=table_id, kind="file", modified=modified))
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
        ref: ``dataset.table`` (``project/dataset.table`` for OAuth links).
        limit: Row cap.

    Returns:
        ``(rows, column_names)``.
    """
    project, ref, _, headers = _config(secret, ref)
    dataset, table = _split_ref(ref)
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
    return rows, import_payload(rows, columns), ref.rsplit(".", 1)[-1]
