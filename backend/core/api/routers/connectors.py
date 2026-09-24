"""Connector endpoints: link outside data accounts and import from them.

The Hugging Face connector lets a user browse and import Hub datasets with
their own account. Linking works two ways: the OAuth flow when the deployment
has registered an OAuth app, or a pasted access token as the fallback. Either
way the credential lands encrypted in :class:`core.connectors.vault.ConnectorVault`
and only ever leaves the server inside requests to Hugging Face.

The other providers (Google Sheets, GitHub, S3, GCS, Azure Blob) share one
generic set of routes keyed by provider slug: save credentials, browse,
preview, import, plus OAuth start/callback for the two that support it.

Imports reuse the library's gated save, so the per-file cap, dedupe and the
storage quota apply exactly as they do to an upload.
"""

from __future__ import annotations

from typing import Annotated, Any
from urllib.parse import urlencode

from fastapi import APIRouter, Depends, Query, Request
from fastapi.responses import RedirectResponse
from pydantic import BaseModel, Field

from ...config import settings
from ...connectors import huggingface as hf
from ...connectors import oauth as generic_oauth
from ...connectors import registry
from ...connectors.transport import label
from ...connectors.vault import ConnectorSecret, ConnectorVault
from ...storage.dataset_library import DatasetLibraryStore, PostgresDatasetBlobStore
from ..auth import AuthenticatedUser, get_authenticated_user
from ..dataset_access import ShareRole
from ..errors import DomainError
from .dataset_library import SaveDatasetResponse, _summary, save_rows_gated

SEARCH_LIMIT_MAX = 100


class ConnectorStatus(BaseModel):
    """One provider's link state for the caller, never carrying the secret."""

    provider: str
    connected: bool
    status: str | None = None
    account_label: str | None = None
    auth_method: str | None = None
    oauth_available: bool
    connected_at: str | None = None


class ConnectorListResponse(BaseModel):
    """Envelope for ``GET /connectors``."""

    connectors: list[ConnectorStatus]


class SaveTokenRequest(BaseModel):
    """Body for the pasted-token fallback."""

    token: str = Field(min_length=1, max_length=512)


class OAuthStartResponse(BaseModel):
    """Where to send the browser to start the OAuth flow."""

    authorize_url: str


class HubDataset(BaseModel):
    """One Hub search hit."""

    id: str
    author: str | None = None
    downloads: int = 0
    likes: int = 0
    private: bool = False
    gated: bool = False
    last_modified: str | None = None


class HubSearchResponse(BaseModel):
    """Envelope for the Hub dataset search."""

    datasets: list[HubDataset]


class HubSplit(BaseModel):
    """One ``(config, split)`` of a Hub dataset with its known size."""

    config: str
    split: str
    num_rows: int | None = None
    num_bytes: int | None = None


class HubSplitsResponse(BaseModel):
    """Envelope for the split listing."""

    splits: list[HubSplit]


class HubColumn(BaseModel):
    """A column of a split as the dataset viewer describes it."""

    name: str
    type: str


class HubPreviewResponse(BaseModel):
    """The first rows of a split."""

    columns: list[HubColumn]
    rows: list[dict[str, Any]]
    num_rows_total: int | None = None


class ImportRequest(BaseModel):
    """Body for importing one split into the caller's library."""

    repo_id: str = Field(min_length=1, max_length=255)
    config: str = Field(min_length=1, max_length=255)
    split: str = Field(min_length=1, max_length=255)
    name: str | None = Field(default=None, max_length=255)


class CredentialsRequest(BaseModel):
    """Body for linking a keys-based provider (or a pasted token)."""

    fields: dict[str, str] = Field(default_factory=dict)


class BrowseEntry(BaseModel):
    """One folder or file in a provider's listing."""

    ref: str
    name: str
    kind: str
    size: int | None = None
    modified: str | None = None


class BrowseResponse(BaseModel):
    """Envelope for ``GET /connectors/{provider}/browse``."""

    entries: list[BrowseEntry]


class RefImportRequest(BaseModel):
    """Body for importing one browsed file into the caller's library."""

    ref: str = Field(min_length=1, max_length=2048)
    name: str | None = Field(default=None, max_length=255)


def create_connectors_router(*, job_store) -> APIRouter:
    """Build the connectors router.

    Args:
        job_store: Storage backend whose ``engine`` carries ``user_connectors``
            and the dataset library tables.

    Returns:
        A configured :class:`APIRouter` under ``/connectors``.
    """
    vault = ConnectorVault(job_store.engine)
    library = DatasetLibraryStore(job_store.engine, PostgresDatasetBlobStore(job_store.engine))
    router = APIRouter()

    def _status(username: str) -> ConnectorListResponse:
        """Describe every provider's link state for ``username``.

        Args:
            username: The caller.

        Returns:
            The list envelope; one entry per supported provider.
        """
        entries: list[ConnectorStatus] = []
        for provider, available in [(hf.PROVIDER, hf.oauth_available())] + [
            (name, registry.oauth_available(name)) for name in registry.PROVIDERS
        ]:
            view = vault.get(username, provider)
            entries.append(
                ConnectorStatus(
                    provider=provider,
                    connected=view is not None,
                    status=view.status if view else None,
                    account_label=view.account_label if view else None,
                    auth_method=view.auth_method if view else None,
                    oauth_available=available,
                    connected_at=view.connected_at.isoformat() if view else None,
                )
            )
        return ConnectorListResponse(connectors=entries)

    def _redirect_uri(request: Request) -> str:
        """Resolve the OAuth callback URL for this deployment.

        Args:
            request: The incoming request, used when no explicit URI is set.

        Returns:
            The absolute callback URL registered on the OAuth app.
        """
        return settings.hf_oauth_redirect_uri or str(request.url_for("huggingface_oauth_callback"))

    def _settings_redirect(error: str | None = None) -> RedirectResponse:
        """Send the browser back to the Connectors tab, optionally with an error.

        Args:
            error: Domain error code to surface, if the link failed.

        Returns:
            A 303 redirect into the frontend.
        """
        params = {"settings": "connectors"}
        if error:
            params["connector_error"] = error
        return RedirectResponse(f"{settings.app_public_url.rstrip('/')}/?{urlencode(params)}", status_code=303)

    @router.get("/connectors", response_model=ConnectorListResponse, summary="List the caller's linked accounts")
    def list_connectors(
        user: Annotated[AuthenticatedUser, Depends(get_authenticated_user)],
    ) -> ConnectorListResponse:
        """Return every supported provider with the caller's link state.

        Args:
            user: Authenticated caller.

        Returns:
            The connector list.
        """
        return _status(user.username)

    @router.put(
        "/connectors/huggingface/token",
        response_model=ConnectorListResponse,
        summary="Link Hugging Face with a pasted access token",
    )
    def save_huggingface_token(
        body: SaveTokenRequest,
        user: Annotated[AuthenticatedUser, Depends(get_authenticated_user)],
    ) -> ConnectorListResponse:
        """Verify a personal access token against Hugging Face and store it.

        Args:
            body: The token.
            user: Authenticated caller.

        Returns:
            The updated connector list.

        Raises:
            DomainError: 400 when Hugging Face rejects the token; 503 when the
                vault is not configured.
        """
        token = body.token.strip()
        account = hf.verify_token(token)
        vault.save(user.username, hf.PROVIDER, access_token=token, auth_method="token", account_label=account)
        return _status(user.username)

    @router.delete(
        "/connectors/huggingface",
        response_model=ConnectorListResponse,
        summary="Unlink Hugging Face",
    )
    def remove_huggingface(
        user: Annotated[AuthenticatedUser, Depends(get_authenticated_user)],
    ) -> ConnectorListResponse:
        """Forget the caller's Hugging Face credentials; a no-op when unlinked.

        Args:
            user: Authenticated caller.

        Returns:
            The updated connector list.
        """
        vault.remove(user.username, hf.PROVIDER)
        return _status(user.username)

    @router.post(
        "/connectors/huggingface/oauth/start",
        response_model=OAuthStartResponse,
        summary="Begin the Hugging Face OAuth flow",
    )
    def start_huggingface_oauth(
        request: Request,
        user: Annotated[AuthenticatedUser, Depends(get_authenticated_user)],
    ) -> OAuthStartResponse:
        """Mint the authorization URL the browser should visit.

        Args:
            request: Incoming request, for deriving the callback URL.
            user: Authenticated caller.

        Returns:
            The authorize URL.

        Raises:
            DomainError: 503 when the OAuth app or the vault is not configured.
        """
        return OAuthStartResponse(authorize_url=hf.build_authorize_url(user.username, _redirect_uri(request)))

    @router.get(
        "/connectors/huggingface/oauth/callback",
        name="huggingface_oauth_callback",
        include_in_schema=False,
    )
    def huggingface_oauth_callback(
        request: Request,
        code: str | None = None,
        state: str | None = None,
        error: str | None = None,
    ) -> RedirectResponse:
        """Finish the OAuth flow and bounce the browser back to Settings.

        This is the one unauthenticated route here: the browser arrives from
        huggingface.co without the app's bearer token, so the encrypted
        ``state`` is what ties the code to the user who started the flow.

        Args:
            request: Incoming request.
            code: Authorization code from Hugging Face.
            state: The encrypted state minted at start.
            error: Hugging Face's error code when the user declined.

        Returns:
            A redirect to the Connectors tab, carrying an error code on failure.
        """
        if error or not code or not state:
            return _settings_redirect("connectors.hf_oauth_failed")
        try:
            payload = hf.parse_state(state)
            tokens = hf.exchange_code(code, payload["v"], payload["r"])
        except DomainError as exc:
            return _settings_redirect(str(exc.code))
        label = hf.fetch_userinfo(tokens.access_token)
        vault.save(
            payload["u"],
            hf.PROVIDER,
            access_token=tokens.access_token,
            auth_method="oauth",
            account_label=label,
            refresh_token=tokens.refresh_token,
            expires_at=tokens.expires_at,
            scopes=tokens.scope,
        )
        return _settings_redirect()

    @router.get(
        "/connectors/huggingface/datasets",
        response_model=HubSearchResponse,
        summary="Search Hugging Face Hub datasets",
    )
    def search_huggingface_datasets(
        user: Annotated[AuthenticatedUser, Depends(get_authenticated_user)],
        search: str = Query(default="", max_length=200),
        limit: int = Query(default=30, ge=1, le=SEARCH_LIMIT_MAX),
    ) -> HubSearchResponse:
        """Search the Hub as the caller (anonymously when unlinked).

        Args:
            user: Authenticated caller.
            search: Free-text query.
            limit: Maximum hits.

        Returns:
            The matching datasets, most downloaded first.
        """
        token = hf.current_token(vault, user.username)
        return HubSearchResponse(datasets=[HubDataset(**d) for d in hf.search_datasets(token, search, limit)])

    @router.get(
        "/connectors/huggingface/datasets/{repo_id:path}/splits",
        response_model=HubSplitsResponse,
        summary="List a Hub dataset's configs and splits",
    )
    def list_huggingface_splits(
        repo_id: str,
        user: Annotated[AuthenticatedUser, Depends(get_authenticated_user)],
    ) -> HubSplitsResponse:
        """List the importable splits of one dataset.

        Args:
            repo_id: Hub repo id, e.g. ``owner/name``.
            user: Authenticated caller.

        Returns:
            The splits with row and byte counts when known.
        """
        token = hf.current_token(vault, user.username)
        return HubSplitsResponse(splits=[HubSplit(**s) for s in hf.list_splits(token, repo_id)])

    @router.get(
        "/connectors/huggingface/datasets/{repo_id:path}/preview",
        response_model=HubPreviewResponse,
        summary="Preview the first rows of a split",
    )
    def preview_huggingface_split(
        repo_id: str,
        user: Annotated[AuthenticatedUser, Depends(get_authenticated_user)],
        config: str = Query(min_length=1, max_length=255),
        split: str = Query(min_length=1, max_length=255),
    ) -> HubPreviewResponse:
        """Show a handful of rows before importing.

        Args:
            repo_id: Hub repo id.
            user: Authenticated caller.
            config: Dataset config.
            split: Split name.

        Returns:
            Columns, the first rows and the split's total row count.
        """
        token = hf.current_token(vault, user.username)
        return HubPreviewResponse(**hf.preview_rows(token, repo_id, config, split))

    @router.post(
        "/connectors/huggingface/import",
        response_model=SaveDatasetResponse,
        summary="Import a Hub split into the caller's library",
    )
    def import_huggingface_split(
        body: ImportRequest,
        user: Annotated[AuthenticatedUser, Depends(get_authenticated_user)],
    ) -> SaveDatasetResponse:
        """Download a split's parquet files and save the rows as a library dataset.

        Args:
            body: Which split to import and what to call it.
            user: Authenticated caller.

        Returns:
            The saved entry and whether an identical one already existed.

        Raises:
            DomainError: 413 when the split exceeds the file cap; 409 over the
                storage quota or when the split cannot be served.
        """
        token = hf.current_token(vault, user.username)
        rows, column_schema = hf.import_split(token, body.repo_id, body.config, body.split)
        name = (body.name or "").strip() or f"{body.repo_id} · {body.split}"
        record, deduped = save_rows_gated(
            job_store,
            library,
            owner=user.username,
            name=name,
            source=hf.PROVIDER,
            rows=rows,
            column_schema=column_schema,
        )
        return SaveDatasetResponse(dataset=_summary(record, ShareRole.owner), deduplicated=deduped)

    def _provider_redirect_uri(request: Request, provider: str) -> str:
        """Resolve a generic provider's OAuth callback URL.

        Args:
            request: The incoming request, used when no explicit URI is set.
            provider: Provider slug.

        Returns:
            The absolute callback URL registered on that provider's OAuth app.
        """
        configured = {
            "google_sheets": settings.google_oauth_redirect_uri,
            "github": settings.github_oauth_redirect_uri,
        }.get(provider)
        return configured or str(request.url_for("connector_oauth_callback", provider=provider))

    def _secret(username: str, provider: str) -> ConnectorSecret:
        """Load the caller's credential for a generic provider, refreshing OAuth tokens.

        Args:
            username: The caller.
            provider: Provider slug.

        Returns:
            The decrypted credential.

        Raises:
            DomainError: 404 for an unknown provider; 409 when unlinked or
                the OAuth grant expired.
        """
        module = registry.get_provider(provider)
        secret = vault.resolve(username, provider)
        if secret is None:
            raise DomainError("connectors.not_connected", status=409, provider=label(provider))
        if secret.auth_method == "oauth":
            token = generic_oauth.current_oauth_token(module.oauth_app(), vault, username)
            secret = ConnectorSecret(
                access_token=token,
                refresh_token=secret.refresh_token,
                expires_at=secret.expires_at,
                auth_method=secret.auth_method,
            )
        return secret

    @router.put(
        "/connectors/{provider}/credentials",
        response_model=ConnectorListResponse,
        summary="Link a provider with pasted credentials",
    )
    def save_connector_credentials(
        provider: str,
        body: CredentialsRequest,
        user: Annotated[AuthenticatedUser, Depends(get_authenticated_user)],
    ) -> ConnectorListResponse:
        """Validate the credentials against the provider and store them encrypted.

        Args:
            provider: Provider slug.
            body: Provider-specific credential fields.
            user: Authenticated caller.

        Returns:
            The updated connector list.

        Raises:
            DomainError: 400 when the provider rejects the credentials; 503
                when the vault key is unset.
        """
        module = registry.get_provider(provider)
        credential = module.verify_credentials(body.fields)
        vault.save(
            user.username,
            provider,
            access_token=credential.secret,
            auth_method=credential.auth_method,
            account_label=credential.account_label,
        )
        return _status(user.username)

    @router.delete(
        "/connectors/{provider}",
        response_model=ConnectorListResponse,
        summary="Unlink a provider",
    )
    def remove_connector(
        provider: str,
        user: Annotated[AuthenticatedUser, Depends(get_authenticated_user)],
    ) -> ConnectorListResponse:
        """Forget the caller's credentials for a provider; a no-op when unlinked.

        Args:
            provider: Provider slug.
            user: Authenticated caller.

        Returns:
            The updated connector list.
        """
        registry.get_provider(provider)
        vault.remove(user.username, provider)
        return _status(user.username)

    @router.post(
        "/connectors/{provider}/oauth/start",
        response_model=OAuthStartResponse,
        summary="Begin a provider's OAuth flow",
    )
    def start_connector_oauth(
        provider: str,
        request: Request,
        user: Annotated[AuthenticatedUser, Depends(get_authenticated_user)],
    ) -> OAuthStartResponse:
        """Mint the authorization URL the browser should visit.

        Args:
            provider: Provider slug (Google Sheets or GitHub).
            request: Incoming request, for deriving the callback URL.
            user: Authenticated caller.

        Returns:
            The authorize URL.

        Raises:
            DomainError: 404 when the provider has no OAuth flow; 503 when its
                OAuth app or the vault is not configured.
        """
        module = registry.get_provider(provider)
        if provider not in registry.OAUTH_PROVIDERS:
            raise DomainError("connectors.unknown_provider", status=404, provider=provider)
        url = generic_oauth.build_authorize_url(
            module.oauth_app(), user.username, _provider_redirect_uri(request, provider)
        )
        return OAuthStartResponse(authorize_url=url)

    @router.get(
        "/connectors/{provider}/oauth/callback",
        name="connector_oauth_callback",
        include_in_schema=False,
    )
    def connector_oauth_callback(
        provider: str,
        request: Request,
        code: str | None = None,
        state: str | None = None,
        error: str | None = None,
    ) -> RedirectResponse:
        """Finish a provider's OAuth flow and bounce the browser back to Settings.

        Unauthenticated like the Hugging Face callback: the encrypted ``state``
        ties the code to the user who started the flow.

        Args:
            provider: Provider slug.
            request: Incoming request.
            code: Authorization code.
            state: The encrypted state minted at start.
            error: The provider's error code when the user declined.

        Returns:
            A redirect to the Connectors tab, carrying an error code on failure.
        """
        if provider not in registry.OAUTH_PROVIDERS:
            return _settings_redirect("connectors.unknown_provider")
        if error or not code or not state:
            return _settings_redirect("connectors.oauth_failed")
        module = registry.get_provider(provider)
        app = module.oauth_app()
        try:
            payload = generic_oauth.parse_state(app, state)
            tokens = generic_oauth.exchange_code(app, code, payload["v"], payload["r"])
        except DomainError as exc:
            return _settings_redirect(str(exc.code))
        vault.save(
            payload["u"],
            provider,
            access_token=tokens.access_token,
            auth_method="oauth",
            account_label=module.fetch_account_label(tokens.access_token),
            refresh_token=tokens.refresh_token,
            expires_at=tokens.expires_at,
            scopes=tokens.scope,
        )
        return _settings_redirect()

    @router.get(
        "/connectors/{provider}/browse",
        response_model=BrowseResponse,
        summary="List folders and importable files at a location",
    )
    def browse_connector(
        provider: str,
        user: Annotated[AuthenticatedUser, Depends(get_authenticated_user)],
        location: str = Query(default="", max_length=2048),
        search: str = Query(default="", max_length=200),
    ) -> BrowseResponse:
        """Browse one level of the provider as the caller.

        Args:
            provider: Provider slug.
            user: Authenticated caller.
            location: Empty for the root, else a folder ref from a previous listing.
            search: Optional name filter.

        Returns:
            Folders first, then importable files.
        """
        module = registry.get_provider(provider)
        entries = module.browse(_secret(user.username, provider), location, search)
        return BrowseResponse(entries=[BrowseEntry(**vars(e)) for e in entries])

    @router.get(
        "/connectors/{provider}/preview",
        response_model=HubPreviewResponse,
        summary="Preview the first rows of a file",
    )
    def preview_connector_ref(
        provider: str,
        user: Annotated[AuthenticatedUser, Depends(get_authenticated_user)],
        ref: str = Query(min_length=1, max_length=2048),
    ) -> HubPreviewResponse:
        """Show a handful of rows before importing.

        Args:
            provider: Provider slug.
            user: Authenticated caller.
            ref: A file ref from a listing.

        Returns:
            Columns and the first rows; the total is unknown for files.
        """
        module = registry.get_provider(provider)
        return HubPreviewResponse(**module.preview(_secret(user.username, provider), ref))

    @router.post(
        "/connectors/{provider}/import",
        response_model=SaveDatasetResponse,
        summary="Import a file into the caller's library",
    )
    def import_connector_ref(
        provider: str,
        body: RefImportRequest,
        user: Annotated[AuthenticatedUser, Depends(get_authenticated_user)],
    ) -> SaveDatasetResponse:
        """Download a file and save its rows as a library dataset.

        Args:
            provider: Provider slug.
            body: Which file to import and what to call it.
            user: Authenticated caller.

        Returns:
            The saved entry and whether an identical one already existed.

        Raises:
            DomainError: 413 when the file exceeds the cap; 409 over the storage
                quota or when the file cannot be decoded.
        """
        module = registry.get_provider(provider)
        rows, column_schema, default_name = module.import_ref(_secret(user.username, provider), body.ref)
        record, deduped = save_rows_gated(
            job_store,
            library,
            owner=user.username,
            name=(body.name or "").strip() or default_name,
            source=provider,
            rows=rows,
            column_schema=column_schema,
        )
        return SaveDatasetResponse(dataset=_summary(record, ShareRole.owner), deduplicated=deduped)

    return router
