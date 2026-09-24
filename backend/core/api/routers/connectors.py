"""Connector endpoints: link outside data accounts and import from them.

The Hugging Face connector lets a user browse and import Hub datasets with
their own account. Linking works two ways: the OAuth flow when the deployment
has registered an OAuth app, or a pasted access token as the fallback. Either
way the credential lands encrypted in :class:`core.connectors.vault.ConnectorVault`
and only ever leaves the server inside requests to Hugging Face.

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
from ...connectors.vault import ConnectorVault
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
        view = vault.get(username, hf.PROVIDER)
        entry = ConnectorStatus(
            provider=hf.PROVIDER,
            connected=view is not None,
            status=view.status if view else None,
            account_label=view.account_label if view else None,
            auth_method=view.auth_method if view else None,
            oauth_available=hf.oauth_available(),
            connected_at=view.connected_at.isoformat() if view else None,
        )
        return ConnectorListResponse(connectors=[entry])

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

    return router
