"""Link the Mac app to a hosted Skynet account (SKY-124). [INTERNAL]

Every ``/local/hosted-link/*`` route exists only in local mode. Hosted
deployments answer 404 and leave them out of the OpenAPI schema. The routes
never return a desktop token; only :mod:`core.local.hosted_link` reads it.
"""

from __future__ import annotations

import html
import platform
from typing import Annotated, Any

from fastapi import APIRouter, Depends
from fastapi.responses import HTMLResponse
from pydantic import BaseModel, Field

from ...i18n_en import t_en
from ...local import hosted_link
from ..auth import AuthenticatedUser, get_authenticated_user
from ..errors import DomainError
from .local_runtime import require_local_mode

AuthenticatedUserDep = Annotated[AuthenticatedUser, Depends(get_authenticated_user)]
_LOCAL_ONLY = [Depends(require_local_mode)]


# Request body of POST /local/hosted-link/start.
class HostedLinkStartRequest(BaseModel):
    device_name: str | None = Field(default=None, max_length=100)


def _page(message: str, *, status: int) -> HTMLResponse:
    """Render the small page the system browser shows after the callback.

    Args:
        message: Plain English text for the user.
        status: HTTP status of the page.

    Returns:
        The HTML response.
    """
    body = (
        '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Skynet</title>'
        '<meta name="viewport" content="width=device-width, initial-scale=1"></head>'
        f'<body style="font-family: system-ui, sans-serif; margin: 3rem auto; max-width: 32rem">'
        f"<p>{html.escape(message)}</p></body></html>"
    )
    return HTMLResponse(
        body, status_code=status, headers={"Cache-Control": "no-store", "Referrer-Policy": "no-referrer"}
    )


def create_local_hosted_link_router(*, job_store: Any) -> APIRouter:
    """Build the local hosted-link router.

    Args:
        job_store: Storage backend whose ``engine`` holds ``user_connectors``.

    Returns:
        A FastAPI ``APIRouter`` with start, callback, status, whoami, balance and unlink.
    """
    router = APIRouter()
    engine = job_store.engine

    @router.post("/local/hosted-link/start", include_in_schema=False, dependencies=_LOCAL_ONLY)
    def start(user: AuthenticatedUserDep, body: HostedLinkStartRequest | None = None) -> dict[str, str]:
        """Return the hosted consent URL for the Mac UI to open in the browser.

        Args:
            user: The signed-in local user.
            body: Optional Mac name for the consent screen.

        Returns:
            ``{"authorize_url": ...}``.
        """
        device_name = (body.device_name if body else None) or platform.node() or "Mac"
        return {"authorize_url": hosted_link.start_link(user.username, device_name=device_name)}

    @router.get("/local/hosted-link/callback", include_in_schema=False, dependencies=_LOCAL_ONLY)
    def callback(code: str | None = None, state: str | None = None, error: str | None = None) -> HTMLResponse:
        """Finish the link from the browser redirect.

        Unauthenticated: the system browser has no local session. The
        encrypted, single-use ``state`` ties the code to this Mac's flow.

        Args:
            code: The single-use link code from hosted.
            state: The state made at start.
            error: Set when the user did not allow the link.

        Returns:
            A page that tells the user to go back to the app.
        """
        if error or not code or not state:
            return _page(t_en("hosted_link.failed"), status=400)
        try:
            view = hosted_link.finish_link(engine, code=code, state=state)
        except DomainError as exc:
            return _page(str(exc.detail), status=exc.status_code)
        label = view.account_label or "your account"
        return _page(f"Linked as {label}. You can go back to the Skynet app.", status=200)

    @router.get("/local/hosted-link/status", include_in_schema=False, dependencies=_LOCAL_ONLY)
    def status(user: AuthenticatedUserDep) -> dict[str, Any]:
        """Report whether the Mac is linked, without calling hosted.

        Args:
            user: The signed-in local user.

        Returns:
            ``{"linked": false}`` or the account email, scopes and link time.
        """
        view = hosted_link.link_status(engine, user.username)
        if view is None:
            return {"linked": False}
        return {
            "linked": True,
            "account_email": view.account_label,
            "scopes": (view.scopes or "").split(),
            "linked_at": view.connected_at.isoformat(),
            "status": view.status,
        }

    @router.get("/local/hosted-link/whoami", include_in_schema=False, dependencies=_LOCAL_ONLY)
    def whoami(user: AuthenticatedUserDep) -> dict[str, Any]:
        """Return the linked hosted account from hosted ``/desktop/v1/whoami``.

        Args:
            user: The signed-in local user.

        Returns:
            ``{"email", "name", "link_id", "scopes", "device_name"}``.
        """
        who = hosted_link.hosted_get(engine, user.username, "/desktop/v1/whoami")
        return {key: who.get(key) for key in ("email", "name", "link_id", "scopes", "device_name")}

    @router.get("/local/hosted-link/balance", include_in_schema=False, dependencies=_LOCAL_ONLY)
    def balance(user: AuthenticatedUserDep) -> dict[str, Any]:
        """Return the hosted credit balance from hosted ``/desktop/v1/balance``.

        Args:
            user: The signed-in local user.

        Returns:
            ``{"available_cents", "currency", "low_balance"}``.
        """
        result = hosted_link.hosted_get(engine, user.username, "/desktop/v1/balance")
        return {key: result.get(key) for key in ("available_cents", "currency", "low_balance")}

    @router.post("/local/hosted-link/unlink", include_in_schema=False, dependencies=_LOCAL_ONLY)
    def unlink(user: AuthenticatedUserDep) -> dict[str, bool]:
        """Revoke the link on hosted (best effort) and delete the local link data.

        Args:
            user: The signed-in local user.

        Returns:
            ``{"hosted_revoked": bool}``; false means the Mac was offline.
        """
        return {"hosted_revoked": hosted_link.unlink(engine, user.username)}

    return router
