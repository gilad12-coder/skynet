"""Palantir Foundry connector: import a dataset's table.

Linking takes the stack's hostname and a token. Browsing starts at the spaces
the token can see and walks their folders and projects down to datasets;
pasting a dataset RID into the search jumps straight to it. Previews and
imports read the table through ``readTable`` as CSV, capped by ``rowLimit``.
"""

from __future__ import annotations

import json
import re
from typing import Any
from urllib.parse import quote

from ..api.errors import DomainError
from .base import Credential, Entry
from .records import PREVIEW_ROWS, row_cap
from .tabular import parse_table
from .transport import download, get_json
from .vault import ConnectorSecret

PROVIDER = "foundry"
PAGE_SIZE = 1000
# Spaces and projects are both Compass folders; only datasets are importable.
FOLDER_PREFIX = "ri.compass.main.folder."
DATASET_PREFIX = "ri.foundry.main.dataset."
RID_PATTERN = re.compile(r"ri\.[a-z0-9-]+\.[a-z0-9-]+\.[a-z0-9-]+\.[A-Za-z0-9-]+")


def _headers(token: str) -> dict[str, str]:
    """Bearer headers for the Foundry platform API.

    Args:
        token: A user or OAuth token.

    Returns:
        The headers.
    """
    return {"Authorization": f"Bearer {token}", "Accept": "application/json"}


def _host(raw: str) -> str:
    """Normalise the hostname field.

    Args:
        raw: The pasted host, a bare hostname or a URL.

    Returns:
        An ``https://`` origin without a path or trailing slash.

    Raises:
        DomainError: 400 when the field is empty.
    """
    host = raw.strip()
    if not host:
        raise DomainError("connectors.invalid_credentials", status=400)
    host = host if host.startswith(("http://", "https://")) else f"https://{host}"
    scheme, _, rest = host.partition("://")
    return f"{scheme}://{rest.split('/', 1)[0]}"


def _config(secret: ConnectorSecret) -> tuple[str, dict[str, str]]:
    """Unpack the stored credential.

    Args:
        secret: The vault entry.

    Returns:
        ``(host, headers)``.
    """
    config = json.loads(secret.access_token)
    return config["host"], _headers(config["token"])


def _rid(ref: str, prefix: str) -> str:
    """Validate a ref as a Foundry RID of one kind.

    Args:
        ref: The ref from the browser.
        prefix: The RID prefix the ref must carry.

    Returns:
        The RID.

    Raises:
        DomainError: 400 for anything else.
    """
    if not ref.startswith(prefix) or not RID_PATTERN.fullmatch(ref):
        raise DomainError("connectors.invalid_ref", status=400)
    return ref


def _pages(host: str, headers: dict[str, str], path: str) -> list[dict[str, Any]]:
    """Read every page of a paginated list endpoint.

    Args:
        host: The stack origin.
        headers: Auth headers.
        path: API path under the host.

    Returns:
        The concatenated ``data`` items.
    """
    items: list[dict[str, Any]] = []
    token: str | None = None
    while True:
        params: dict[str, Any] = {"pageSize": PAGE_SIZE}
        if token:
            params["pageToken"] = token
        body = get_json(f"{host}{path}", provider=PROVIDER, headers=headers, params=params)
        data = body.get("data") if isinstance(body, dict) else None
        items += [i for i in data if isinstance(i, dict)] if isinstance(data, list) else []
        token = body.get("nextPageToken") if isinstance(body, dict) else None
        if not token:
            return items


def verify_credentials(fields: dict[str, str]) -> Credential:
    """Validate a token by listing the spaces it can see.

    Args:
        fields: ``{"host": ..., "token": ...}``.

    Returns:
        The credential to store, labelled with the Foundry username when the
        token may read it, else the hostname.

    Raises:
        DomainError: 400 when Foundry rejects the token.
    """
    token = fields.get("token", "").strip()
    if not token:
        raise DomainError("connectors.invalid_credentials", status=400)
    host = _host(fields.get("host", ""))
    headers = _headers(token)
    try:
        get_json(f"{host}/api/v2/filesystem/spaces", provider=PROVIDER, headers=headers, params={"pageSize": 1})
    except DomainError as exc:
        if exc.code in {"connectors.rejected", "connectors.not_found"}:
            raise DomainError("connectors.invalid_credentials", status=400) from exc
        raise
    label = host.partition("://")[2]
    # A token scoped to datasets alone may not read its own user; the hostname still names the account.
    try:
        user = get_json(f"{host}/api/v2/admin/users/getCurrent", provider=PROVIDER, headers=headers)
        username = user.get("username") if isinstance(user, dict) else None
        label = username if isinstance(username, str) and username else label
    except DomainError:
        pass
    secret = json.dumps({"host": host, "token": token})
    return Credential(secret=secret, auth_method="token", account_label=label)


def _entry(resource: dict[str, Any]) -> Entry | None:
    """Turn a filesystem resource into a browse entry.

    Args:
        resource: A space or folder child.

    Returns:
        A folder for spaces, projects and folders, a file for datasets, else ``None``.
    """
    rid = resource.get("rid")
    if not isinstance(rid, str):
        return None
    name = resource.get("displayName") or rid
    modified = resource.get("updatedTime")
    if rid.startswith(FOLDER_PREFIX):
        return Entry(ref=rid, name=name, kind="folder", modified=modified)
    if rid.startswith(DATASET_PREFIX):
        return Entry(ref=rid, name=name, kind="file", modified=modified)
    return None


def _dataset_name(host: str, headers: dict[str, str], rid: str) -> str:
    """Read a dataset's name.

    Args:
        host: The stack origin.
        headers: Auth headers.
        rid: The dataset RID.

    Returns:
        The name, or the RID when Foundry gives none.
    """
    body = get_json(f"{host}/api/v2/datasets/{quote(rid, safe='')}", provider=PROVIDER, headers=headers)
    name = body.get("name") if isinstance(body, dict) else None
    return name if isinstance(name, str) and name else rid


def browse(secret: ConnectorSecret, location: str, search: str) -> list[Entry]:
    """List spaces at the root, or the folders and datasets inside one folder.

    Args:
        secret: The stored connector.
        location: Empty for the root, else a folder RID.
        search: Name filter; a dataset RID at the root opens that dataset.

    Returns:
        The entries.
    """
    host, headers = _config(secret)
    needle = search.strip()
    if not location and needle.startswith(DATASET_PREFIX):
        rid = _rid(needle, DATASET_PREFIX)
        return [Entry(ref=rid, name=_dataset_name(host, headers, rid), kind="file")]
    if location:
        path = f"/api/v2/filesystem/folders/{quote(_rid(location, FOLDER_PREFIX), safe='')}/children"
    else:
        path = "/api/v2/filesystem/spaces"
    entries = [e for e in (_entry(r) for r in _pages(host, headers, path)) if e is not None]
    return [e for e in entries if needle.lower() in e.name.lower()]


def _read_table(secret: ConnectorSecret, ref: str, limit: int) -> bytes:
    """Download a dataset's table as CSV.

    ``rowLimit`` keeps even a preview small, so no byte range is needed.

    Args:
        secret: The stored connector.
        ref: A dataset RID.
        limit: Row cap passed as ``rowLimit``.

    Returns:
        The CSV bytes.
    """
    host, headers = _config(secret)
    rid = quote(_rid(ref, DATASET_PREFIX), safe="")
    content, _ = download(
        f"{host}/api/v2/datasets/{rid}/readTable",
        provider=PROVIDER,
        headers={**headers, "Accept": "*/*"},
        params={"format": "CSV", "rowLimit": limit},
    )
    return content


def preview(secret: ConnectorSecret, ref: str) -> dict[str, Any]:
    """Read the first rows of a dataset.

    Args:
        secret: The stored connector.
        ref: A dataset RID from :func:`browse`.

    Returns:
        The preview envelope.
    """
    table = parse_table(_read_table(secret, ref, PREVIEW_ROWS), "table.csv", limit=PREVIEW_ROWS)
    return {"columns": table.columns, "rows": table.rows, "num_rows_total": None}


def import_ref(secret: ConnectorSecret, ref: str) -> tuple[list[dict[str, Any]], dict[str, Any], str]:
    """Read a dataset's rows, up to the row cap.

    Args:
        secret: The stored connector.
        ref: A dataset RID from :func:`browse`.

    Returns:
        ``(rows, column_schema, default_name)``.
    """
    table = parse_table(_read_table(secret, ref, row_cap()), "table.csv")
    host, headers = _config(secret)
    return table.rows, table.column_schema, _dataset_name(host, headers, ref)
