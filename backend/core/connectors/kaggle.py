"""Kaggle connector: browse datasets and import a file from one.

Linking takes the username and API key from a ``kaggle.json`` token file.
Browsing lists the account's own datasets alongside the most popular ones,
searches the whole catalogue by keyword, then lists the files of one dataset.
Kaggle serves single-file downloads zipped for some datasets, so the
download step unpacks a zip transparently.
"""

from __future__ import annotations

import base64
import io
import json
import zipfile
from typing import Any
from urllib.parse import quote

from ..api.errors import DomainError
from .base import Credential, Entry, import_file, preview_file
from .tabular import check_size, download_ceiling, is_supported
from .transport import download, get_json
from .vault import ConnectorSecret

PROVIDER = "kaggle"
API_URL = "https://www.kaggle.com/api/v1"
LIST_LIMIT = 40
ZIP_MAGIC = b"PK\x03\x04"


def _headers(username: str, key: str) -> dict[str, str]:
    """Basic-auth headers for the Kaggle API.

    Args:
        username: Kaggle username.
        key: API key.

    Returns:
        The headers.
    """
    token = base64.b64encode(f"{username}:{key}".encode()).decode("ascii")
    return {"Authorization": f"Basic {token}", "Accept": "application/json"}


def _config(secret: ConnectorSecret) -> tuple[str, dict[str, str]]:
    """Unpack the stored credential.

    Args:
        secret: The vault entry.

    Returns:
        ``(username, headers)``.
    """
    config = json.loads(secret.access_token)
    return config["username"], _headers(config["username"], config["key"])


def verify_credentials(fields: dict[str, str]) -> Credential:
    """Validate a username/key pair by listing one dataset with it.

    Args:
        fields: ``{"username": ..., "key": ...}``.

    Returns:
        The credential to store, labelled with the username.

    Raises:
        DomainError: 400 when Kaggle rejects the pair.
    """
    username = fields.get("username", "").strip()
    key = fields.get("key", "").strip()
    if not username or not key:
        raise DomainError("connectors.invalid_credentials", status=400)
    try:
        get_json(
            f"{API_URL}/datasets/list",
            provider=PROVIDER,
            headers=_headers(username, key),
            params={"page": 1, "pageSize": 1},
        )
    except DomainError as exc:
        if exc.code == "connectors.rejected":
            raise DomainError("connectors.invalid_credentials", status=400) from exc
        raise
    secret = json.dumps({"username": username, "key": key})
    return Credential(secret=secret, auth_method="credentials", account_label=username)


def _dataset_entries(items: Any) -> list[Entry]:
    """Turn a dataset listing into folder entries keyed ``owner/slug``.

    Args:
        items: The API's list.

    Returns:
        The entries.
    """
    entries: list[Entry] = []
    for item in items if isinstance(items, list) else []:
        ref = item.get("ref")
        if not isinstance(ref, str) or ref.count("/") != 1:
            continue
        entries.append(
            Entry(
                ref=ref,
                name=item.get("title") or ref,
                kind="folder",
                size=item.get("totalBytes"),
                modified=item.get("lastUpdated"),
            )
        )
    return entries


def _list_datasets(username: str, headers: dict[str, str], search: str) -> list[Entry]:
    """List datasets: a keyword search, or the account's own plus the hottest.

    Args:
        username: Kaggle username, whose datasets lead the default listing.
        headers: Auth headers.
        search: Keyword filter.

    Returns:
        Folder entries.
    """
    if search.strip():
        body = get_json(
            f"{API_URL}/datasets/list",
            provider=PROVIDER,
            headers=headers,
            params={"search": search.strip(), "page": 1, "pageSize": LIST_LIMIT},
        )
        return _dataset_entries(body)
    mine = _dataset_entries(
        get_json(
            f"{API_URL}/datasets/list",
            provider=PROVIDER,
            headers=headers,
            params={"user": username, "page": 1, "pageSize": LIST_LIMIT},
        )
    )
    hottest = _dataset_entries(
        get_json(
            f"{API_URL}/datasets/list",
            provider=PROVIDER,
            headers=headers,
            params={"sortBy": "hottest", "page": 1, "pageSize": LIST_LIMIT},
        )
    )
    seen = {e.ref for e in mine}
    return mine + [e for e in hottest if e.ref not in seen]


def _list_files(headers: dict[str, str], owner: str, slug: str) -> list[Entry]:
    """List the importable files of one dataset.

    Args:
        headers: Auth headers.
        owner: Dataset owner.
        slug: Dataset slug.

    Returns:
        File entries keyed ``owner/slug/file``.
    """
    body = get_json(
        f"{API_URL}/datasets/list/{quote(owner, safe='')}/{quote(slug, safe='')}",
        provider=PROVIDER,
        headers=headers,
    )
    files = body.get("datasetFiles") if isinstance(body, dict) else None
    return [
        Entry(
            ref=f"{owner}/{slug}/{f['name']}",
            name=f["name"],
            kind="file",
            size=f.get("totalBytes"),
            modified=f.get("creationDate"),
        )
        for f in files or []
        if isinstance(f.get("name"), str) and is_supported(f["name"])
    ]


def _split_ref(ref: str) -> tuple[str, str, str]:
    """Split ``owner/slug/path/to/file``.

    Args:
        ref: A file ref from :func:`browse`.

    Returns:
        ``(owner, slug, file_name)``.

    Raises:
        DomainError: 400 when the ref has no file part.
    """
    parts = ref.split("/", 2)
    if len(parts) != 3 or not all(parts):
        raise DomainError("connectors.invalid_ref", status=400)
    return parts[0], parts[1], parts[2]


def browse(secret: ConnectorSecret, location: str, search: str) -> list[Entry]:
    """List datasets at the root, or the files of one dataset.

    Args:
        secret: The stored connector.
        location: Empty for the root, else ``owner/slug``.
        search: Keyword filter, honoured at the root.

    Returns:
        The entries.
    """
    username, headers = _config(secret)
    if not location:
        return _list_datasets(username, headers, search)
    owner, _, slug = location.strip("/").partition("/")
    if not owner or not slug:
        raise DomainError("connectors.invalid_ref", status=400)
    return _list_files(headers, owner, slug.split("/", 1)[0])


def _unzip(content: bytes, file_name: str) -> bytes:
    """Return the file's bytes, unpacking a zip wrapper when Kaggle sent one.

    Args:
        content: The downloaded bytes.
        file_name: The file that was asked for.

    Returns:
        The raw file bytes.

    Raises:
        DomainError: 413 when the unpacked file would exceed the ceiling; 409
            when the archive is unreadable.
    """
    if not content.startswith(ZIP_MAGIC):
        return content
    try:
        with zipfile.ZipFile(io.BytesIO(content)) as archive:
            members = [m for m in archive.infolist() if not m.is_dir()]
            wanted = next((m for m in members if m.filename.rsplit("/", 1)[-1] == file_name.rsplit("/", 1)[-1]), None)
            member = wanted or (members[0] if members else None)
            if member is None:
                raise DomainError("connectors.file_unsupported", status=409)
            check_size(member.file_size)
            return archive.read(member)
    except zipfile.BadZipFile as exc:
        raise DomainError("connectors.file_unsupported", status=409) from exc


def _fetcher(headers: dict[str, str], ref: str):
    """Build the download closure for one file ref.

    Downloads are always complete: a zipped file cannot be previewed from a
    byte range, and the import ceiling still bounds the transfer.

    Args:
        headers: Auth headers.
        ref: ``owner/slug/file``.

    Returns:
        A callable taking an ignored byte cap and returning ``(bytes, False)``.
    """
    owner, slug, file_name = _split_ref(ref)
    url = f"{API_URL}/datasets/download/{quote(owner, safe='')}/{quote(slug, safe='')}/{quote(file_name)}"

    def fetch(_max_bytes: int | None) -> tuple[bytes, bool]:
        """Download and unpack the whole file.

        Returns:
            ``(content, False)``.
        """
        content, _ = download(url, provider=PROVIDER, headers=headers, max_bytes=download_ceiling())
        return _unzip(content, file_name), False

    return fetch


def preview(secret: ConnectorSecret, ref: str) -> dict[str, Any]:
    """Decode the first rows of a dataset file.

    Args:
        secret: The stored connector.
        ref: ``owner/slug/file``.

    Returns:
        ``{"columns": [...], "rows": [...], "num_rows_total": None}``.
    """
    _, headers = _config(secret)
    return preview_file(_fetcher(headers, ref), ref)


def import_ref(secret: ConnectorSecret, ref: str) -> tuple[list[dict[str, Any]], dict[str, Any], str]:
    """Download a dataset file and decode every row.

    Args:
        secret: The stored connector.
        ref: ``owner/slug/file``.

    Returns:
        ``(rows, column_schema, default_name)``.
    """
    _, headers = _config(secret)
    owner, slug, file_name = _split_ref(ref)
    listed = next((e for e in _list_files(headers, owner, slug) if e.ref == ref), None)
    check_size(listed.size if listed else None)
    rows, schema = import_file(_fetcher(headers, ref), ref)
    return rows, schema, f"{slug}/{file_name.rsplit('/', 1)[-1]}"
