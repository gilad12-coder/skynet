"""Azure Blob Storage connector.

Credentials are a storage-account connection string (account name plus key,
or a blob endpoint plus SAS token) or a SAS URL, optionally scoped to one
container. Shared Key requests are signed here directly; SAS credentials are
appended to every URL. Only the three read calls are used: list containers,
list blobs under a prefix, download a blob.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import xml.etree.ElementTree as ET
from email.utils import formatdate
from typing import Any
from urllib.parse import quote, urlsplit

from ..api.errors import DomainError
from .base import Credential, Entry, Fetch, import_file, preview_file, range_header, split_location
from .tabular import check_size, is_supported
from .transport import download, request
from .vault import ConnectorSecret

PROVIDER = "azure_blob"
API_VERSION = "2021-08-06"
LIST_LIMIT = 1000
DEFAULT_SUFFIX = "core.windows.net"
STANDARD_HEADERS = (
    "content-encoding",
    "content-language",
    "content-length",
    "content-md5",
    "content-type",
    "date",
    "if-modified-since",
    "if-match",
    "if-none-match",
    "if-unmodified-since",
    "range",
)


def parse_connection(raw: str) -> dict[str, str]:
    """Normalise a connection string or SAS URL into the stored credential.

    Args:
        raw: What the user pasted.

    Returns:
        ``{"account", "endpoint", "key", "sas", "container"}`` with empty
        strings for the unused fields.

    Raises:
        DomainError: 400 when neither an account key nor a SAS token is present.
    """
    text = raw.strip()
    if text.lower().startswith(("http://", "https://")):
        parts = urlsplit(text)
        account = parts.hostname.split(".")[0] if parts.hostname else ""
        container = parts.path.strip("/").split("/", 1)[0]
        if not account or not parts.query:
            raise DomainError("connectors.invalid_credentials", status=400)
        return {
            "account": account,
            "endpoint": f"{parts.scheme}://{parts.netloc}",
            "key": "",
            "sas": parts.query,
            "container": container,
        }
    pairs: dict[str, str] = {}
    for segment in text.split(";"):
        name, _, value = segment.partition("=")
        if name.strip():
            pairs[name.strip().lower()] = value.strip()
    account = pairs.get("accountname", "")
    key = pairs.get("accountkey", "")
    sas = pairs.get("sharedaccesssignature", "").lstrip("?")
    endpoint = pairs.get("blobendpoint", "").rstrip("/")
    if endpoint and not account:
        host = urlsplit(endpoint).hostname or ""
        account = host.split(".")[0]
    if not endpoint and account:
        protocol = pairs.get("defaultendpointsprotocol", "https")
        endpoint = f"{protocol}://{account}.blob.{pairs.get('endpointsuffix', DEFAULT_SUFFIX)}"
    if not account or not endpoint or not (key or sas):
        raise DomainError("connectors.invalid_credentials", status=400)
    return {"account": account, "endpoint": endpoint, "key": key, "sas": sas, "container": ""}


def string_to_sign(method: str, account: str, path: str, query: dict[str, str], headers: dict[str, str]) -> str:
    """Build the Shared Key string-to-sign for a request without a body.

    Args:
        method: HTTP method.
        account: Storage account name.
        path: URL path (``/container/blob``), already percent-encoded.
        query: Decoded query parameters.
        headers: Request headers (``x-ms-*`` and ``Range`` are picked up).

    Returns:
        The string to sign.
    """
    lower = {k.lower(): v for k, v in headers.items()}
    standard = "\n".join(lower.get(name, "") for name in STANDARD_HEADERS)
    canonical_headers = "".join(f"{k}:{lower[k]}\n" for k in sorted(lower) if k.startswith("x-ms-"))
    resource = f"/{account}{path or '/'}" + "".join(f"\n{k.lower()}:{query[k]}" for k in sorted(query, key=str.lower))
    return f"{method}\n{standard}\n{canonical_headers}{resource}"


def sign(config: dict[str, str], method: str, path: str, query: dict[str, str], headers: dict[str, str]) -> str:
    """Compute the ``Authorization`` value for a Shared Key request.

    Args:
        config: Decoded credentials with a ``key``.
        method: HTTP method.
        path: URL path, percent-encoded.
        query: Decoded query parameters.
        headers: Request headers including ``x-ms-date`` and ``x-ms-version``.

    Returns:
        ``SharedKey <account>:<signature>``.
    """
    digest = hmac.new(
        base64.b64decode(config["key"]),
        string_to_sign(method, config["account"], path, query, headers).encode("utf-8"),
        hashlib.sha256,
    ).digest()
    return f"SharedKey {config['account']}:{base64.b64encode(digest).decode('ascii')}"


def _prepare(
    config: dict[str, str], method: str, path: str, query: dict[str, str], extra: dict[str, str] | None = None
) -> tuple[str, dict[str, str]]:
    """Build the URL and headers for one call, signed or SAS-authenticated.

    Args:
        config: Decoded credentials.
        method: HTTP method.
        path: URL path, percent-encoded.
        query: Query parameters.
        extra: Extra headers (``Range``).

    Returns:
        ``(url, headers)``.
    """
    headers = {"x-ms-date": formatdate(usegmt=True), "x-ms-version": API_VERSION, **(extra or {})}
    encoded = "&".join(f"{quote(k, safe='')}={quote(v, safe='')}" for k, v in query.items())
    if config.get("sas"):
        encoded = f"{encoded}&{config['sas']}" if encoded else config["sas"]
    else:
        headers["Authorization"] = sign(config, method, path, query, headers)
    url = f"{config['endpoint']}{path}"
    return (f"{url}?{encoded}" if encoded else url), headers


def _config(secret: ConnectorSecret) -> dict[str, str]:
    """Decode the stored credential JSON.

    Args:
        secret: The vault entry.

    Returns:
        The credential dict produced by :func:`parse_connection`.
    """
    return json.loads(secret.access_token)


def _xml(body: bytes) -> ET.Element:
    """Parse an Azure XML body.

    Args:
        body: The response bytes.

    Returns:
        The root element.

    Raises:
        DomainError: 502 when the body is not XML.
    """
    try:
        return ET.fromstring(body)
    except ET.ParseError as exc:
        raise DomainError("connectors.provider_error", status=502, provider=PROVIDER, status_code=200) from exc


def _list_containers(config: dict[str, str]) -> list[Entry]:
    """List the account's containers.

    Args:
        config: Decoded credentials.

    Returns:
        Folder entries keyed by container name.
    """
    url, headers = _prepare(config, "GET", "/", {"comp": "list", "maxresults": str(LIST_LIMIT)})
    root = _xml(request("GET", url, provider=PROVIDER, headers=headers).content)
    entries: list[Entry] = []
    for container in root.iter("Container"):
        name = container.findtext("Name")
        if name:
            entries.append(
                Entry(ref=name, name=name, kind="folder", modified=container.findtext("Properties/Last-Modified"))
            )
    return entries


def _list_blobs(config: dict[str, str], container: str, prefix: str) -> list[Entry]:
    """List one "directory" of a container.

    Args:
        config: Decoded credentials.
        container: Container name.
        prefix: Blob-name prefix, ends with ``/`` unless at the root.

    Returns:
        Folder entries for sub-prefixes and file entries for importable blobs.
    """
    query = {"restype": "container", "comp": "list", "delimiter": "/", "maxresults": str(LIST_LIMIT)}
    if prefix:
        query["prefix"] = prefix
    url, headers = _prepare(config, "GET", f"/{quote(container, safe='')}", query)
    root = _xml(request("GET", url, provider=PROVIDER, headers=headers).content)
    folders: list[Entry] = []
    files: list[Entry] = []
    for element in root.iter():
        name = element.findtext("Name")
        if not name:
            continue
        if element.tag == "BlobPrefix":
            folders.append(Entry(ref=f"{container}/{name}", name=name[len(prefix) :].rstrip("/"), kind="folder"))
        elif element.tag == "Blob" and name != prefix and is_supported(name):
            size = element.findtext("Properties/Content-Length") or ""
            files.append(
                Entry(
                    ref=f"{container}/{name}",
                    name=name[len(prefix) :],
                    kind="file",
                    size=int(size) if size.isdigit() else None,
                    modified=element.findtext("Properties/Last-Modified"),
                )
            )
    return folders + files


def verify_credentials(fields: dict[str, str]) -> Credential:
    """Validate a connection string or SAS URL by listing containers or blobs.

    Args:
        fields: ``connection`` (connection string or SAS URL) and the
            optional ``container``.

    Returns:
        The credential to store, labelled with the account (and container).

    Raises:
        DomainError: 400 when the input is malformed or Azure rejects it.
    """
    config = parse_connection(fields.get("connection", ""))
    container = fields.get("container", "").strip() or config["container"]
    config["container"] = container
    try:
        if container:
            _list_blobs(config, container, "")
        else:
            _list_containers(config)
    except DomainError as exc:
        if exc.code in ("connectors.rejected", "connectors.not_found"):
            raise DomainError("connectors.invalid_credentials", status=400) from exc
        raise
    label = f"{config['account']}/{container}" if container else config["account"]
    return Credential(secret=json.dumps(config), auth_method="credentials", account_label=label)


def browse(secret: ConnectorSecret, location: str, search: str) -> list[Entry]:
    """List containers at the root, or one prefix of a container.

    Args:
        secret: The stored connector.
        location: Empty for the root, else ``container/prefix/``.
        search: Substring filter applied to the listing.

    Returns:
        The entries.
    """
    config = _config(secret)
    if not location:
        if config.get("container"):
            entries = [Entry(ref=config["container"], name=config["container"], kind="folder")]
        else:
            entries = _list_containers(config)
    else:
        container, prefix = split_location(location)
        entries = _list_blobs(config, container, prefix)
    needle = search.strip().lower()
    return [e for e in entries if needle in e.name.lower()] if needle else entries


def _split_ref(ref: str) -> tuple[str, str]:
    """Split ``container/blob`` and refuse refs without a blob name.

    Args:
        ref: A file ref.

    Returns:
        ``(container, blob)``.

    Raises:
        DomainError: 400 when the ref has no blob part.
    """
    container, blob = split_location(ref)
    if not container or not blob or blob.endswith("/"):
        raise DomainError("connectors.invalid_ref", status=400)
    return container, blob


def _blob_path(container: str, blob: str) -> str:
    """Percent-encode the path of one blob.

    Args:
        container: Container name.
        blob: Blob name.

    Returns:
        ``/container/blob``.
    """
    return f"/{quote(container, safe='')}/{quote(blob, safe='/')}"


def _fetcher(config: dict[str, str], container: str, blob: str) -> Fetch:
    """Build the download closure for one blob.

    Args:
        config: Decoded credentials.
        container: Container name.
        blob: Blob name.

    Returns:
        A callable taking an optional byte cap and returning ``(bytes, truncated)``.
    """
    path = _blob_path(container, blob)

    def fetch(max_bytes: int | None) -> tuple[bytes, bool]:
        """Download the blob, honouring the cap.

        Args:
            max_bytes: Byte cap for previews, ``None`` for the whole blob.

        Returns:
            ``(content, truncated)``.
        """
        url, headers = _prepare(config, "GET", path, {}, range_header(max_bytes))
        return download(url, provider=PROVIDER, headers=headers, max_bytes=max_bytes)

    return fetch


def preview(secret: ConnectorSecret, ref: str) -> dict[str, Any]:
    """Decode the first rows of a blob.

    Args:
        secret: The stored connector.
        ref: ``container/blob``.

    Returns:
        ``{"columns": [...], "rows": [...], "num_rows_total": None}``.
    """
    container, blob = _split_ref(ref)
    return preview_file(_fetcher(_config(secret), container, blob), blob)


def import_ref(secret: ConnectorSecret, ref: str) -> tuple[list[dict[str, Any]], dict[str, Any], str]:
    """Download a blob and decode every row.

    Args:
        secret: The stored connector.
        ref: ``container/blob``.

    Returns:
        ``(rows, column_schema, default_name)``.
    """
    container, blob = _split_ref(ref)
    config = _config(secret)
    url, headers = _prepare(config, "HEAD", _blob_path(container, blob), {})
    head = request("HEAD", url, provider=PROVIDER, headers=headers)
    length = head.headers.get("content-length")
    check_size(int(length) if length and length.isdigit() else None)
    rows, schema = import_file(_fetcher(config, container, blob), blob)
    return rows, schema, blob.rsplit("/", 1)[-1]
