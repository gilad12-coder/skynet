"""Google Drive connector: browse folders and import a data file.

Linking works through Google OAuth (Drive read-only) or a pasted
service-account key that sees whatever was shared with it. Browsing starts
at "My Drive" plus files shared with the account, descends into folders and
searches by name across the whole drive; CSV, TSV, JSON, JSONL and Parquet
files import directly and a Google Sheet is exported as CSV (first tab).
"""

from __future__ import annotations

import json
from typing import Any
from urllib.parse import quote

from ..api.errors import DomainError
from ..config import settings
from .base import Credential, Entry, import_file, preview_file, range_header
from .google_auth import parse_service_account, service_account_token
from .oauth import OAuthApp
from .oauth import oauth_available as _oauth_available
from .tabular import check_size, is_supported
from .transport import download, get_json
from .vault import ConnectorSecret

PROVIDER = "google_drive"
DRIVE_URL = "https://www.googleapis.com/drive/v3/files"
USERINFO_URL = "https://www.googleapis.com/oauth2/v3/userinfo"
SCOPES = "openid email https://www.googleapis.com/auth/drive.readonly"
LIST_LIMIT = 100
FOLDER_MIME = "application/vnd.google-apps.folder"
SPREADSHEET_MIME = "application/vnd.google-apps.spreadsheet"
FIELDS = "files(id,name,mimeType,size,modifiedTime)"
DRIVE_PARAMS = {"supportsAllDrives": "true", "includeItemsFromAllDrives": "true"}


def oauth_app() -> OAuthApp:
    """Describe the Google OAuth client from settings (shared with Sheets).

    Returns:
        The app; ``client_id`` is ``None`` when unconfigured.
    """
    secret = settings.google_oauth_client_secret
    return OAuthApp(
        provider=PROVIDER,
        authorize_url="https://accounts.google.com/o/oauth2/v2/auth",
        token_url="https://oauth2.googleapis.com/token",
        scopes=SCOPES,
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


def _headers(token: str) -> dict[str, str]:
    """Bearer headers for Google APIs.

    Args:
        token: The access token.

    Returns:
        The headers.
    """
    return {"Authorization": f"Bearer {token}", "Accept": "application/json"}


def fetch_account_label(token: str) -> str | None:
    """Look up the e-mail behind an OAuth token.

    Args:
        token: A Google access token.

    Returns:
        The account e-mail, or ``None`` when Google withholds it.
    """
    try:
        body = get_json(USERINFO_URL, provider=PROVIDER, headers=_headers(token))
    except DomainError:
        return None
    email = body.get("email") if isinstance(body, dict) else None
    return email if isinstance(email, str) else None


def _bearer(secret: ConnectorSecret) -> str:
    """Resolve the access token behind a stored connector.

    Args:
        secret: The vault entry; an OAuth token or a service-account key.

    Returns:
        A bearer token.
    """
    if secret.auth_method == "oauth":
        return secret.access_token
    return service_account_token(json.loads(secret.access_token), SCOPES, PROVIDER)


def verify_credentials(fields: dict[str, str]) -> Credential:
    """Validate a pasted service-account key by minting a token with it.

    Args:
        fields: ``{"service_account_json": ...}``.

    Returns:
        The credential to store; the label is the service account's e-mail.
    """
    key = parse_service_account(fields.get("service_account_json", ""))
    service_account_token(key, SCOPES, PROVIDER)
    return Credential(secret=json.dumps(key), auth_method="service_account", account_label=key["client_email"])


def _escape(value: str) -> str:
    """Escape a value for a Drive query string literal.

    Args:
        value: The raw value.

    Returns:
        The escaped value.
    """
    return value.replace("\\", "\\\\").replace("'", "\\'")


def _entry(file: dict[str, Any]) -> Entry | None:
    """Turn one Drive file into a browse entry, or ``None`` when not importable.

    Args:
        file: The Drive file resource.

    Returns:
        The entry.
    """
    file_id, name, mime = file.get("id"), file.get("name") or "", file.get("mimeType")
    if not isinstance(file_id, str):
        return None
    if mime == FOLDER_MIME:
        return Entry(ref=file_id, name=name or file_id, kind="folder", modified=file.get("modifiedTime"))
    if mime == SPREADSHEET_MIME or is_supported(name):
        size = int(file["size"]) if str(file.get("size", "")).isdigit() else None
        return Entry(ref=file_id, name=name or file_id, kind="file", size=size, modified=file.get("modifiedTime"))
    return None


def browse(secret: ConnectorSecret, location: str, search: str) -> list[Entry]:
    """List a folder, or search the whole drive by name.

    Args:
        secret: The stored connector.
        location: Empty for the top level, else a folder id.
        search: Name filter; when set, the whole drive is searched.

    Returns:
        Folders first, then importable files.
    """
    if search.strip():
        query = f"name contains '{_escape(search.strip())}'"
    elif location:
        query = f"'{_escape(location)}' in parents"
    else:
        query = "'root' in parents or sharedWithMe = true"
    body = get_json(
        DRIVE_URL,
        provider=PROVIDER,
        headers=_headers(_bearer(secret)),
        params={
            "q": f"({query}) and trashed = false",
            "fields": FIELDS,
            "pageSize": LIST_LIMIT,
            "orderBy": "folder,modifiedTime desc",
            **DRIVE_PARAMS,
        },
    )
    entries = [e for f in (body.get("files") if isinstance(body, dict) else None) or [] if (e := _entry(f))]
    return [e for e in entries if e.kind == "folder"] + [e for e in entries if e.kind == "file"]


def _metadata(token: str, file_id: str) -> dict[str, Any]:
    """Read a file's name, type and size.

    Args:
        token: Bearer token.
        file_id: Drive file id.

    Returns:
        The metadata.
    """
    body = get_json(
        f"{DRIVE_URL}/{quote(file_id, safe='')}",
        provider=PROVIDER,
        headers=_headers(token),
        params={"fields": "id,name,mimeType,size", "supportsAllDrives": "true"},
    )
    if not isinstance(body, dict) or not isinstance(body.get("name"), str):
        raise DomainError("connectors.invalid_ref", status=400)
    return body


def _fetcher(token: str, meta: dict[str, Any]):
    """Build the download closure for a file: raw bytes, or a CSV export of a Sheet.

    Args:
        token: Bearer token.
        meta: The file's metadata.

    Returns:
        A callable taking an optional byte cap and returning ``(bytes, truncated)``.
    """
    file_id = quote(meta["id"], safe="")
    if meta.get("mimeType") == SPREADSHEET_MIME:
        url, params = f"{DRIVE_URL}/{file_id}/export", {"mimeType": "text/csv"}
    else:
        url, params = f"{DRIVE_URL}/{file_id}", {"alt": "media", "supportsAllDrives": "true"}

    def fetch(max_bytes: int | None) -> tuple[bytes, bool]:
        """Download the file, honouring the cap.

        Args:
            max_bytes: Byte cap for previews, ``None`` for the whole file.

        Returns:
            ``(content, truncated)``.
        """
        headers = {**_headers(token), **range_header(max_bytes)}
        return download(url, provider=PROVIDER, headers=headers, max_bytes=max_bytes, params=params)

    return fetch


def _decoder_name(meta: dict[str, Any]) -> str:
    """Name used to pick the table decoder.

    Args:
        meta: The file's metadata.

    Returns:
        The file name, with ``.csv`` appended for an exported Sheet.
    """
    name = meta["name"]
    return f"{name}.csv" if meta.get("mimeType") == SPREADSHEET_MIME else name


def preview(secret: ConnectorSecret, ref: str) -> dict[str, Any]:
    """Decode the first rows of a file.

    Args:
        secret: The stored connector.
        ref: Drive file id.

    Returns:
        ``{"columns": [...], "rows": [...], "num_rows_total": None}``.
    """
    token = _bearer(secret)
    meta = _metadata(token, ref)
    return preview_file(_fetcher(token, meta), _decoder_name(meta))


def import_ref(secret: ConnectorSecret, ref: str) -> tuple[list[dict[str, Any]], dict[str, Any], str]:
    """Download a file and decode every row.

    Args:
        secret: The stored connector.
        ref: Drive file id.

    Returns:
        ``(rows, column_schema, default_name)``.
    """
    token = _bearer(secret)
    meta = _metadata(token, ref)
    check_size(int(meta["size"]) if str(meta.get("size", "")).isdigit() else None)
    rows, schema = import_file(_fetcher(token, meta), _decoder_name(meta))
    return rows, schema, meta["name"]
