"""OneDrive connector: browse a Microsoft account's files and import one.

Linking is OAuth only, through the Microsoft identity platform with the
``Files.Read`` scopes; personal and work accounts both sign in through the
``common`` tenant. Browsing walks the drive through Microsoft Graph and
searches by name; CSV, TSV, JSON, JSONL and Parquet files are importable.
"""

from __future__ import annotations

from typing import Any
from urllib.parse import quote

from ..api.errors import DomainError
from ..config import settings
from .base import Credential, Entry, import_file, preview_file, range_header
from .oauth import OAuthApp
from .oauth import oauth_available as _oauth_available
from .tabular import check_size, is_supported
from .transport import download, get_json
from .vault import ConnectorSecret

PROVIDER = "onedrive"
GRAPH_URL = "https://graph.microsoft.com/v1.0"
SCOPES = "openid email offline_access User.Read Files.Read Files.Read.All"
LIST_LIMIT = 200
SELECT = "id,name,size,lastModifiedDateTime,folder,file"


def oauth_app() -> OAuthApp:
    """Describe the Microsoft OAuth app from settings.

    Returns:
        The app; ``client_id`` is ``None`` when unconfigured.
    """
    secret = settings.microsoft_oauth_client_secret
    return OAuthApp(
        provider=PROVIDER,
        authorize_url="https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
        token_url="https://login.microsoftonline.com/common/oauth2/v2.0/token",
        scopes=SCOPES,
        client_id=settings.microsoft_oauth_client_id,
        client_secret=secret.get_secret_value() if secret is not None else None,
        extra_authorize_params={"response_mode": "query", "prompt": "select_account"},
    )


def oauth_available() -> bool:
    """Report whether "Continue with Microsoft" can be offered.

    Returns:
        ``True`` when the client id and the vault key are configured.
    """
    return _oauth_available(oauth_app())


def _headers(token: str) -> dict[str, str]:
    """Bearer headers for Microsoft Graph.

    Args:
        token: The access token.

    Returns:
        The headers.
    """
    return {"Authorization": f"Bearer {token}", "Accept": "application/json"}


def fetch_account_label(token: str) -> str | None:
    """Look up the signed-in account's address.

    Args:
        token: A Graph access token.

    Returns:
        The e-mail or user principal name, or ``None`` when unavailable.
    """
    try:
        body = get_json(f"{GRAPH_URL}/me", provider=PROVIDER, headers=_headers(token))
    except DomainError:
        return None
    if not isinstance(body, dict):
        return None
    value = body.get("mail") or body.get("userPrincipalName")
    return value if isinstance(value, str) else None


def verify_credentials(fields: dict[str, str]) -> Credential:
    """Reject pasted credentials: OneDrive links through OAuth only.

    Args:
        fields: Ignored.

    Raises:
        DomainError: 400 always.
    """
    raise DomainError("connectors.invalid_credentials", status=400)


def _entry(item: dict[str, Any]) -> Entry | None:
    """Turn one drive item into a browse entry, or ``None`` when not importable.

    Args:
        item: The Graph driveItem.

    Returns:
        The entry.
    """
    item_id, name = item.get("id"), item.get("name") or ""
    if not isinstance(item_id, str):
        return None
    if "folder" in item:
        return Entry(ref=item_id, name=name or item_id, kind="folder", modified=item.get("lastModifiedDateTime"))
    if is_supported(name):
        return Entry(
            ref=item_id, name=name, kind="file", size=item.get("size"), modified=item.get("lastModifiedDateTime")
        )
    return None


def browse(secret: ConnectorSecret, location: str, search: str) -> list[Entry]:
    """List a folder, or search the drive by name.

    Args:
        secret: The stored connector.
        location: Empty for the drive root, else an item id.
        search: Name filter; when set, the whole drive is searched.

    Returns:
        Folders first, then importable files.
    """
    if search.strip():
        url = f"{GRAPH_URL}/me/drive/root/search(q='{quote(search.strip().replace(chr(39), chr(39) * 2), safe='')}')"
    elif location:
        url = f"{GRAPH_URL}/me/drive/items/{quote(location, safe='')}/children"
    else:
        url = f"{GRAPH_URL}/me/drive/root/children"
    body = get_json(
        url, provider=PROVIDER, headers=_headers(secret.access_token), params={"$select": SELECT, "$top": LIST_LIMIT}
    )
    items = body.get("value") if isinstance(body, dict) else None
    entries = [e for item in items or [] if isinstance(item, dict) and (e := _entry(item))]
    return [e for e in entries if e.kind == "folder"] + [e for e in entries if e.kind == "file"]


def _metadata(token: str, item_id: str) -> dict[str, Any]:
    """Read an item's name and size.

    Args:
        token: Bearer token.
        item_id: Drive item id.

    Returns:
        The metadata.
    """
    body = get_json(
        f"{GRAPH_URL}/me/drive/items/{quote(item_id, safe='')}",
        provider=PROVIDER,
        headers=_headers(token),
        params={"$select": "id,name,size"},
    )
    if not isinstance(body, dict) or not isinstance(body.get("name"), str):
        raise DomainError("connectors.invalid_ref", status=400)
    return body


def _fetcher(token: str, item_id: str):
    """Build the download closure for one item.

    Args:
        token: Bearer token.
        item_id: Drive item id.

    Returns:
        A callable taking an optional byte cap and returning ``(bytes, truncated)``.
    """
    url = f"{GRAPH_URL}/me/drive/items/{quote(item_id, safe='')}/content"

    def fetch(max_bytes: int | None) -> tuple[bytes, bool]:
        """Download the item's content, honouring the cap.

        Args:
            max_bytes: Byte cap for previews, ``None`` for the whole file.

        Returns:
            ``(content, truncated)``.
        """
        headers = {**_headers(token), **range_header(max_bytes)}
        return download(url, provider=PROVIDER, headers=headers, max_bytes=max_bytes)

    return fetch


def preview(secret: ConnectorSecret, ref: str) -> dict[str, Any]:
    """Decode the first rows of a file.

    Args:
        secret: The stored connector.
        ref: Drive item id.

    Returns:
        ``{"columns": [...], "rows": [...], "num_rows_total": None}``.
    """
    meta = _metadata(secret.access_token, ref)
    return preview_file(_fetcher(secret.access_token, ref), meta["name"])


def import_ref(secret: ConnectorSecret, ref: str) -> tuple[list[dict[str, Any]], dict[str, Any], str]:
    """Download a file and decode every row.

    Args:
        secret: The stored connector.
        ref: Drive item id.

    Returns:
        ``(rows, column_schema, default_name)``.
    """
    meta = _metadata(secret.access_token, ref)
    check_size(meta.get("size") if isinstance(meta.get("size"), int) else None)
    rows, schema = import_file(_fetcher(secret.access_token, ref), meta["name"])
    return rows, schema, meta["name"]
