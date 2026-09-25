"""Google Sheets connector: browse a user's spreadsheets and import a tab.

Linking works through Google OAuth (Drive and Sheets read-only scopes) when
the deployment registered a Google OAuth client, or with a pasted
service-account key, which then sees whichever spreadsheets were shared with
that service account. Browsing lists spreadsheets from Drive, then the tabs
of one spreadsheet; importing reads a tab with its first row as the header.
"""

from __future__ import annotations

import json
from typing import Any
from urllib.parse import quote

from ..api.errors import DomainError
from ..config import settings
from .base import Credential, Entry
from .google_auth import parse_service_account, service_account_token
from .oauth import OAuthApp
from .oauth import oauth_available as _oauth_available
from .transport import get_json
from .vault import ConnectorSecret

PROVIDER = "google_sheets"
DRIVE_URL = "https://www.googleapis.com/drive/v3/files"
SHEETS_URL = "https://sheets.googleapis.com/v4/spreadsheets"
USERINFO_URL = "https://www.googleapis.com/oauth2/v3/userinfo"
SCOPES = (
    "openid email https://www.googleapis.com/auth/spreadsheets.readonly https://www.googleapis.com/auth/drive.readonly"
)
LIST_LIMIT = 50
PREVIEW_ROWS = 20
SPREADSHEET_MIME = "application/vnd.google-apps.spreadsheet"


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
        scopes=SCOPES,
        client_id=settings.google_oauth_client_id,
        client_secret=secret.get_secret_value() if secret is not None else None,
        # ``offline`` + ``consent`` is what makes Google hand out a refresh token.
        extra_authorize_params={"access_type": "offline", "prompt": "consent", "include_granted_scopes": "true"},
    )


def oauth_available() -> bool:
    """Report whether "Continue with Google" can be offered.

    Returns:
        ``True`` when the client id and the vault key are configured.
    """
    return _oauth_available(oauth_app())


def fetch_account_label(token: str) -> str | None:
    """Look up the e-mail behind an OAuth token for the connector card.

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


def _headers(token: str) -> dict[str, str]:
    """Bearer headers for Google APIs.

    Args:
        token: The access token.

    Returns:
        The headers.
    """
    return {"Authorization": f"Bearer {token}", "Accept": "application/json"}


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

    Raises:
        DomainError: 400 when the key is malformed or Google refuses it.
    """
    key = parse_service_account(fields.get("service_account_json", ""))
    service_account_token(key, SCOPES, PROVIDER)
    return Credential(secret=json.dumps(key), auth_method="service_account", account_label=key["client_email"])


def _list_spreadsheets(token: str, search: str) -> list[Entry]:
    """List spreadsheets the account can read, newest first.

    Args:
        token: Bearer token.
        search: Optional name filter.

    Returns:
        Folder entries keyed by spreadsheet id.
    """
    query = f"mimeType='{SPREADSHEET_MIME}' and trashed=false"
    if search:
        escaped = search.replace("\\", "\\\\").replace("'", "\\'")
        query += f" and name contains '{escaped}'"
    body = get_json(
        DRIVE_URL,
        provider=PROVIDER,
        headers=_headers(token),
        params={
            "q": query,
            "fields": "files(id,name,modifiedTime)",
            "pageSize": LIST_LIMIT,
            "orderBy": "modifiedTime desc",
            "supportsAllDrives": "true",
            "includeItemsFromAllDrives": "true",
        },
    )
    return [
        Entry(ref=f["id"], name=f.get("name") or f["id"], kind="folder", modified=f.get("modifiedTime"))
        for f in body.get("files") or []
        if isinstance(f.get("id"), str)
    ]


def _list_tabs(token: str, spreadsheet_id: str) -> list[Entry]:
    """List the tabs of one spreadsheet.

    Args:
        token: Bearer token.
        spreadsheet_id: Drive file id.

    Returns:
        File entries keyed ``"<spreadsheet id>/<tab title>"``.
    """
    body = get_json(
        f"{SHEETS_URL}/{quote(spreadsheet_id, safe='')}",
        provider=PROVIDER,
        headers=_headers(token),
        params={"fields": "sheets.properties(title,gridProperties(rowCount))"},
    )
    entries: list[Entry] = []
    for sheet in body.get("sheets") or []:
        props = sheet.get("properties") or {}
        title = props.get("title")
        if not isinstance(title, str):
            continue
        rows = (props.get("gridProperties") or {}).get("rowCount")
        entries.append(Entry(ref=f"{spreadsheet_id}/{title}", name=title, kind="file", size=rows))
    return entries


def browse(secret: ConnectorSecret, location: str, search: str) -> list[Entry]:
    """List spreadsheets at the root, or one spreadsheet's tabs.

    Args:
        secret: The stored connector.
        location: Empty for the root, else a spreadsheet id.
        search: Name filter, honoured at the root.

    Returns:
        The entries.
    """
    token = _bearer(secret)
    if not location:
        return _list_spreadsheets(token, search)
    return _list_tabs(token, location)


def _split_ref(ref: str) -> tuple[str, str]:
    """Split ``"<spreadsheet id>/<tab title>"``.

    Args:
        ref: A file ref from :func:`browse`.

    Returns:
        ``(spreadsheet_id, tab_title)``.

    Raises:
        DomainError: 400 when the ref has no tab part.
    """
    spreadsheet_id, _, title = ref.partition("/")
    if not spreadsheet_id or not title:
        raise DomainError("connectors.invalid_ref", status=400)
    return spreadsheet_id, title


def _values(token: str, spreadsheet_id: str, a1_range: str) -> list[list[Any]]:
    """Read a range of cell values.

    Args:
        token: Bearer token.
        spreadsheet_id: Drive file id.
        a1_range: A1-notation range, tab title included.

    Returns:
        The rows as the API returns them (ragged, trailing blanks dropped).
    """
    body = get_json(
        f"{SHEETS_URL}/{quote(spreadsheet_id, safe='')}/values/{quote(a1_range, safe='')}",
        provider=PROVIDER,
        headers=_headers(token),
        params={"valueRenderOption": "UNFORMATTED_VALUE", "dateTimeRenderOption": "FORMATTED_STRING"},
    )
    values = body.get("values") or []
    return values if isinstance(values, list) else []


def _table(values: list[list[Any]]) -> tuple[list[dict[str, Any]], list[str]]:
    """Turn the header row plus data rows into row dicts.

    Blank header cells become ``column_<n>`` so no value is silently dropped.

    Args:
        values: Raw cell rows, header first.

    Returns:
        ``(rows, column_order)``.
    """
    if not values:
        return [], []
    header = [str(cell).strip() or f"column_{index + 1}" for index, cell in enumerate(values[0])]
    rows: list[dict[str, Any]] = []
    for raw in values[1:]:
        if not any(cell not in ("", None) for cell in raw):
            continue
        padded = list(raw) + [None] * (len(header) - len(raw))
        rows.append({name: padded[index] for index, name in enumerate(header)})
    return rows, header


def _quoted_tab(title: str) -> str:
    """Quote a tab title for A1 notation.

    Args:
        title: The tab title.

    Returns:
        The quoted title.
    """
    return "'" + title.replace("'", "''") + "'"


def preview(secret: ConnectorSecret, ref: str) -> dict[str, Any]:
    """Read the header and the first rows of a tab.

    Args:
        secret: The stored connector.
        ref: ``"<spreadsheet id>/<tab title>"``.

    Returns:
        ``{"columns": [...], "rows": [...], "num_rows_total": None}``.
    """
    spreadsheet_id, title = _split_ref(ref)
    values = _values(_bearer(secret), spreadsheet_id, f"{_quoted_tab(title)}!1:{PREVIEW_ROWS + 1}")
    rows, header = _table(values)
    return {"columns": [{"name": name, "type": "string"} for name in header], "rows": rows, "num_rows_total": None}


def import_ref(secret: ConnectorSecret, ref: str) -> tuple[list[dict[str, Any]], dict[str, Any], str]:
    """Read a whole tab into library rows.

    Args:
        secret: The stored connector.
        ref: ``"<spreadsheet id>/<tab title>"``.

    Returns:
        ``(rows, column_schema, default_name)``.
    """
    spreadsheet_id, title = _split_ref(ref)
    rows, header = _table(_values(_bearer(secret), spreadsheet_id, _quoted_tab(title)))
    schema = {"column_order": header, "column_roles": {}, "column_kinds": {}}
    return rows, schema, title
