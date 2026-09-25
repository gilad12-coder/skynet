"""Amazon S3 connector (and S3-compatible stores such as MinIO or R2).

Credentials are an access key pair plus a region, optionally pinned to one
bucket and pointed at a custom endpoint. Requests are signed with AWS
Signature Version 4 directly, which keeps ``boto3`` out of the dependency
tree for what amounts to three GET calls: list buckets, list objects, get
object.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import xml.etree.ElementTree as ET
from datetime import UTC, datetime
from typing import Any
from urllib.parse import quote, urlsplit

from ..api.errors import DomainError
from .base import Credential, Entry, Fetch, import_file, preview_file, range_header, split_location
from .tabular import check_size, is_supported
from .transport import download, request
from .vault import ConnectorSecret

PROVIDER = "s3"
SERVICE = "s3"
EMPTY_SHA256 = hashlib.sha256(b"").hexdigest()
LIST_LIMIT = 1000
S3_NS = "{http://s3.amazonaws.com/doc/2006-03-01/}"


def _quote(text: str) -> str:
    """Percent-encode the way SigV4 canonicalisation requires.

    Args:
        text: A path segment or query component.

    Returns:
        The encoded text (``/`` encoded too).
    """
    return quote(text, safe="-_.~")


def _sign(key: bytes, message: str) -> bytes:
    """HMAC-SHA256 one step of the signing-key derivation.

    Args:
        key: The key.
        message: The message.

    Returns:
        The digest.
    """
    return hmac.new(key, message.encode("utf-8"), hashlib.sha256).digest()


def sign_request(
    method: str,
    url: str,
    *,
    access_key: str,
    secret_key: str,
    region: str,
    headers: dict[str, str] | None = None,
    now: datetime | None = None,
) -> dict[str, str]:
    """Produce the SigV4 headers for an unsigned-payload request.

    Args:
        method: HTTP method.
        url: Absolute URL with the query already encoded via :func:`_quote`.
        access_key: AWS access key id.
        secret_key: AWS secret access key.
        region: Signing region.
        headers: Extra headers to sign (``Range`` for previews).
        now: Override the clock (tests).

    Returns:
        ``headers`` plus ``Host``, ``x-amz-date``, ``x-amz-content-sha256``
        and ``Authorization``.
    """
    parts = urlsplit(url)
    stamp = (now or datetime.now(UTC)).strftime("%Y%m%dT%H%M%SZ")
    date = stamp[:8]
    signed: dict[str, str] = {
        **(headers or {}),
        "host": parts.netloc,
        "x-amz-content-sha256": EMPTY_SHA256,
        "x-amz-date": stamp,
    }
    canonical_headers = "".join(f"{k.lower()}:{' '.join(signed[k].split())}\n" for k in sorted(signed, key=str.lower))
    signed_names = ";".join(sorted(k.lower() for k in signed))
    query = "&".join(sorted(parts.query.split("&"))) if parts.query else ""
    canonical_request = "\n".join(
        [method, parts.path or "/", query, canonical_headers, signed_names, EMPTY_SHA256],
    )
    scope = f"{date}/{region}/{SERVICE}/aws4_request"
    string_to_sign = "\n".join(
        ["AWS4-HMAC-SHA256", stamp, scope, hashlib.sha256(canonical_request.encode("utf-8")).hexdigest()]
    )
    signing_key = _sign(_sign(_sign(_sign(f"AWS4{secret_key}".encode(), date), region), SERVICE), "aws4_request")
    signature = hmac.new(signing_key, string_to_sign.encode("utf-8"), hashlib.sha256).hexdigest()
    signed["Authorization"] = (
        f"AWS4-HMAC-SHA256 Credential={access_key}/{scope}, SignedHeaders={signed_names}, Signature={signature}"
    )
    return signed


def _config(secret: ConnectorSecret) -> dict[str, str]:
    """Decode the stored credential JSON.

    Args:
        secret: The vault entry.

    Returns:
        ``{access_key_id, secret_access_key, region, endpoint_url?, bucket?}``.
    """
    return json.loads(secret.access_token)


def _base_url(config: dict[str, str], bucket: str | None) -> str:
    """Resolve the endpoint for a bucket (virtual-hosted on AWS, path-style elsewhere).

    Args:
        config: Decoded credentials.
        bucket: Bucket name, or ``None`` for the service root.

    Returns:
        The URL without a trailing slash.
    """
    endpoint = (config.get("endpoint_url") or "").rstrip("/")
    if endpoint:
        return f"{endpoint}/{_quote(bucket)}" if bucket else endpoint
    region = config["region"]
    return f"https://{_quote(bucket)}.s3.{region}.amazonaws.com" if bucket else f"https://s3.{region}.amazonaws.com"


def _get(config: dict[str, str], url: str, headers: dict[str, str] | None = None) -> bytes:
    """Perform one signed GET.

    Args:
        config: Decoded credentials.
        url: Absolute URL with the query already encoded.
        headers: Extra headers to sign and send.

    Returns:
        The response body.
    """
    signed = sign_request(
        "GET",
        url,
        access_key=config["access_key_id"],
        secret_key=config["secret_access_key"],
        region=config["region"],
        headers=headers,
    )
    return request("GET", url, provider=PROVIDER, headers=signed).content


def _xml(body: bytes) -> ET.Element:
    """Parse an S3 XML body.

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


def _text(element: ET.Element | None, tag: str) -> str | None:
    """Read a namespaced child's text.

    Args:
        element: Parent element.
        tag: Child tag without namespace.

    Returns:
        The text, or ``None``.
    """
    if element is None:
        return None
    child = element.find(f"{S3_NS}{tag}")
    if child is None:
        child = element.find(tag)
    return child.text if child is not None else None


def _list_buckets(config: dict[str, str]) -> list[Entry]:
    """List the buckets the key pair owns.

    Args:
        config: Decoded credentials.

    Returns:
        Folder entries keyed by bucket name.
    """
    root = _xml(_get(config, f"{_base_url(config, None)}/"))
    entries: list[Entry] = []
    for bucket in root.iter():
        if bucket.tag.removeprefix(S3_NS) != "Bucket":
            continue
        name = _text(bucket, "Name")
        if name:
            entries.append(Entry(ref=name, name=name, kind="folder", modified=_text(bucket, "CreationDate")))
    return entries


def _list_objects(config: dict[str, str], bucket: str, prefix: str) -> list[Entry]:
    """List one "directory" of a bucket via ``ListObjectsV2`` with a delimiter.

    Args:
        config: Decoded credentials.
        bucket: Bucket name.
        prefix: Key prefix (ends with ``/`` unless at the root).

    Returns:
        Folder entries for common prefixes and file entries for importable keys.
    """
    query = f"delimiter={_quote('/')}&list-type=2&max-keys={LIST_LIMIT}&prefix={_quote(prefix)}"
    root = _xml(_get(config, f"{_base_url(config, bucket)}/?{query}"))
    folders: list[Entry] = []
    files: list[Entry] = []
    for element in root.iter():
        tag = element.tag.removeprefix(S3_NS)
        if tag == "CommonPrefixes":
            key = _text(element, "Prefix")
            if key:
                folders.append(Entry(ref=f"{bucket}/{key}", name=key[len(prefix) :].rstrip("/"), kind="folder"))
        elif tag == "Contents":
            key = _text(element, "Key")
            if key and key != prefix and is_supported(key):
                size = _text(element, "Size")
                files.append(
                    Entry(
                        ref=f"{bucket}/{key}",
                        name=key[len(prefix) :],
                        kind="file",
                        size=int(size) if size and size.isdigit() else None,
                        modified=_text(element, "LastModified"),
                    )
                )
    return folders + files


def verify_credentials(fields: dict[str, str]) -> Credential:
    """Validate a key pair by listing buckets (or the pinned bucket).

    Args:
        fields: ``access_key_id``, ``secret_access_key``, ``region`` and the
            optional ``endpoint_url`` and ``bucket``.

    Returns:
        The credential to store; the label is the bucket when pinned, else
        the access key id.

    Raises:
        DomainError: 400 when a required field is missing or the store rejects
            the keys.
    """
    config = {
        "access_key_id": fields.get("access_key_id", "").strip(),
        "secret_access_key": fields.get("secret_access_key", "").strip(),
        "region": fields.get("region", "").strip() or "us-east-1",
        "endpoint_url": fields.get("endpoint_url", "").strip(),
        "bucket": fields.get("bucket", "").strip(),
    }
    if not config["access_key_id"] or not config["secret_access_key"]:
        raise DomainError("connectors.invalid_credentials", status=400)
    try:
        if config["bucket"]:
            _list_objects(config, config["bucket"], "")
        else:
            _list_buckets(config)
    except DomainError as exc:
        if exc.code in ("connectors.rejected", "connectors.not_found"):
            raise DomainError("connectors.invalid_credentials", status=400) from exc
        raise
    label = config["bucket"] or config["access_key_id"]
    return Credential(secret=json.dumps(config), auth_method="credentials", account_label=label)


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
    if not location:
        entries = (
            [Entry(ref=config["bucket"], name=config["bucket"], kind="folder")]
            if config.get("bucket")
            else (_list_buckets(config))
        )
    else:
        bucket, prefix = split_location(location)
        entries = _list_objects(config, bucket, prefix)
    needle = search.strip().lower()
    return [e for e in entries if needle in e.name.lower()] if needle else entries


def _fetcher(config: dict[str, str], bucket: str, key: str) -> Fetch:
    """Build the signed download closure for one object.

    Args:
        config: Decoded credentials.
        bucket: Bucket name.
        key: Object key.

    Returns:
        A callable taking an optional byte cap and returning ``(bytes, truncated)``.
    """
    url = f"{_base_url(config, bucket)}/{quote(key, safe='-_.~/')}"

    def fetch(max_bytes: int | None) -> tuple[bytes, bool]:
        """Download the object, honouring the cap.

        Args:
            max_bytes: Byte cap for previews, ``None`` for the whole object.

        Returns:
            ``(content, truncated)``.
        """
        signed = sign_request(
            "GET",
            url,
            access_key=config["access_key_id"],
            secret_key=config["secret_access_key"],
            region=config["region"],
            headers=range_header(max_bytes),
        )
        return download(url, provider=PROVIDER, headers=signed, max_bytes=max_bytes)

    return fetch


def _split_ref(ref: str) -> tuple[str, str]:
    """Split ``bucket/key`` and refuse refs without a key.

    Args:
        ref: A file ref.

    Returns:
        ``(bucket, key)``.

    Raises:
        DomainError: 400 when the ref has no key.
    """
    bucket, key = split_location(ref)
    if not bucket or not key or key.endswith("/"):
        raise DomainError("connectors.invalid_ref", status=400)
    return bucket, key


def preview(secret: ConnectorSecret, ref: str) -> dict[str, Any]:
    """Decode the first rows of an object.

    Args:
        secret: The stored connector.
        ref: ``bucket/key``.

    Returns:
        ``{"columns": [...], "rows": [...], "num_rows_total": None}``.
    """
    bucket, key = _split_ref(ref)
    return preview_file(_fetcher(_config(secret), bucket, key), key)


def import_ref(secret: ConnectorSecret, ref: str) -> tuple[list[dict[str, Any]], dict[str, Any], str]:
    """Download an object and decode every row.

    Args:
        secret: The stored connector.
        ref: ``bucket/key``.

    Returns:
        ``(rows, column_schema, default_name)``.
    """
    bucket, key = _split_ref(ref)
    config = _config(secret)
    url = f"{_base_url(config, bucket)}/{quote(key, safe='-_.~/')}"
    signed = sign_request(
        "HEAD",
        url,
        access_key=config["access_key_id"],
        secret_key=config["secret_access_key"],
        region=config["region"],
    )
    head = request("HEAD", url, provider=PROVIDER, headers=signed)
    length = head.headers.get("content-length")
    check_size(int(length) if length and length.isdigit() else None)
    rows, schema = import_file(_fetcher(config, bucket, key), key)
    return rows, schema, key.rsplit("/", 1)[-1]
