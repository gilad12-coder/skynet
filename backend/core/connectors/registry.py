"""Lookup table from provider name to connector module.

Every module here exposes ``PROVIDER``, ``verify_credentials``, ``browse``,
``preview`` and ``import_ref``; the OAuth-capable ones (Google Sheets,
Google Drive, OneDrive, GitHub) additionally expose ``oauth_app``, ``oauth_available`` and
``fetch_account_label``. Hugging Face keeps its own module and routes.
"""

from __future__ import annotations

from types import ModuleType

from ..api.errors import DomainError
from . import (
    azure_blob,
    bigquery,
    braintrust,
    gcs,
    github,
    google_drive,
    google_sheets,
    kaggle,
    langfuse,
    langsmith,
    mysql,
    notion,
    onedrive,
    postgres,
    s3,
    snowflake,
)

PROVIDERS: dict[str, ModuleType] = {
    kaggle.PROVIDER: kaggle,
    google_sheets.PROVIDER: google_sheets,
    google_drive.PROVIDER: google_drive,
    onedrive.PROVIDER: onedrive,
    github.PROVIDER: github,
    s3.PROVIDER: s3,
    gcs.PROVIDER: gcs,
    azure_blob.PROVIDER: azure_blob,
    postgres.PROVIDER: postgres,
    mysql.PROVIDER: mysql,
    bigquery.PROVIDER: bigquery,
    snowflake.PROVIDER: snowflake,
    langfuse.PROVIDER: langfuse,
    langsmith.PROVIDER: langsmith,
    braintrust.PROVIDER: braintrust,
    notion.PROVIDER: notion,
}
OAUTH_PROVIDERS = frozenset({google_sheets.PROVIDER, google_drive.PROVIDER, onedrive.PROVIDER, github.PROVIDER})


def get_provider(name: str) -> ModuleType:
    """Resolve a provider module by name.

    Args:
        name: The provider slug from the URL.

    Returns:
        The module.

    Raises:
        DomainError: 404 for an unknown slug.
    """
    try:
        return PROVIDERS[name]
    except KeyError as exc:
        raise DomainError("connectors.unknown_provider", status=404, provider=name) from exc


def oauth_available(name: str) -> bool:
    """Report whether a provider offers an OAuth flow right now.

    Args:
        name: Provider slug.

    Returns:
        ``True`` only for configured OAuth providers.
    """
    return name in OAUTH_PROVIDERS and PROVIDERS[name].oauth_available()
