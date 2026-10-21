"""Notification routes only the single-user Mac app has. [INTERNAL]

Local mode keeps every hosted channel and adds native macOS notifications.
These routes exist only in local mode: hosted deployments answer 404 and
leave them out of the OpenAPI schema, so the public contract is unchanged.
"""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Annotated

from fastapi import APIRouter, Depends, Header
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from ...i18n import request_locale
from ...notifications import slack
from ...notifications.catalog import CHROME, EMAIL, MACOS, SLACK
from ...notifications.channels import vapid_public_key
from ...notifications.native import claim_native
from ...notifications.preferences import merge_grid
from ...storage.models import NotificationPreferenceModel
from ..auth import AuthenticatedUser, get_authenticated_user
from ..email_sender import email_configured
from .local_runtime import require_local_mode
from .notification_preferences import EventTypeValue

AuthenticatedUserDep = Annotated[AuthenticatedUser, Depends(get_authenticated_user)]
AcceptLanguageDep = Annotated[str | None, Header(include_in_schema=False)]


class LocalNotificationChannels(BaseModel):
    channels: dict[str, bool] = Field(description="Delivery channel -> whether this Mac can deliver on it now.")
    macos: dict[EventTypeValue, bool] = Field(description="Event type -> whether it shows as a macOS notification.")


class MacOSCellsUpdate(BaseModel):
    grid: dict[EventTypeValue, bool] = Field(description="macOS cells to change; others keep their value.")


class NativeNotificationItem(BaseModel):
    id: str = Field(description="Notification id.")
    title: str = Field(description="Notification headline.")
    body: str = Field(description="Optional second line.")
    url: str = Field(description="App path the notification opens.")
    tag: str = Field(description="Replaces an earlier notification with the same tag.")


class NativeNotificationClaimRequest(BaseModel):
    locale: str | None = Field(default=None, description="The Mac app's UI locale for the display text.")


class NativeNotificationClaim(BaseModel):
    items: list[NativeNotificationItem] = Field(description="Queued notifications to show, oldest first.")


def _channel_states() -> dict[str, bool]:
    """Report which delivery channels work on this Mac.

    A hosted channel works when this Mac has its own setup for it (SMTP,
    VAPID keys, a Slack app); a hosted-account link (SKY-124) does not exist yet.

    Returns:
        Delivery channel -> available, the hosted ones first.
    """
    return {
        EMAIL: email_configured(),
        CHROME: vapid_public_key() is not None,
        SLACK: slack.slack_configured(),
        MACOS: True,
    }


def _macos_cells(row: NotificationPreferenceModel | None) -> dict[str, bool]:
    """Return the effective macOS column of a stored grid.

    Args:
        row: The stored preferences, or ``None``.

    Returns:
        Event type -> on.
    """
    grid = merge_grid(row.channel_grid if row is not None else None)
    return {event: cells[MACOS] for event, cells in grid.items()}


def create_local_notifications_router(*, job_store) -> APIRouter:
    """Build the Mac app's notification router.

    Args:
        job_store: Job-store instance whose ORM engine holds notifications and preferences.

    Returns:
        A router exposing the channel states, the macOS cells and the native claim.
    """
    router = APIRouter(dependencies=[Depends(require_local_mode)])

    @router.get("/local/notifications/channels", include_in_schema=False)
    def local_notification_channels(user: AuthenticatedUserDep) -> LocalNotificationChannels:
        """Report each channel's state and the caller's macOS cells.

        Args:
            user: The signed-in local user.

        Returns:
            The channel states and the macOS column.
        """
        with Session(job_store.engine) as session:
            row = session.get(NotificationPreferenceModel, user.username)
            return LocalNotificationChannels(channels=_channel_states(), macos=_macos_cells(row))

    @router.patch("/local/notifications/macos", include_in_schema=False)
    def update_macos_cells(body: MacOSCellsUpdate, user: AuthenticatedUserDep) -> LocalNotificationChannels:
        """Change the caller's macOS cells.

        Args:
            body: The cells to change.
            user: The signed-in local user.

        Returns:
            The channel states and the macOS column after the change.
        """
        with Session(job_store.engine) as session:
            row = session.get(NotificationPreferenceModel, user.username)
            if row is None:
                row = NotificationPreferenceModel(username=user.username)
                session.add(row)
            grid = merge_grid(row.channel_grid)
            for event, on in body.grid.items():
                grid[event][MACOS] = on
            row.channel_grid = merge_grid(grid)
            row.updated_at = datetime.now(UTC)
            session.commit()
            session.refresh(row)
            return LocalNotificationChannels(channels=_channel_states(), macos=_macos_cells(row))

    @router.post("/local/notifications/native/claim", include_in_schema=False)
    def claim_native_notifications(
        user: AuthenticatedUserDep,
        request: NativeNotificationClaimRequest | None = None,
        accept_language: AcceptLanguageDep = None,
    ) -> NativeNotificationClaim:
        """Hand the Mac app the caller's queued macOS notifications, each once.

        Args:
            user: The signed-in local user.
            request: Optional body naming the app's UI locale.
            accept_language: The browser's languages, used when the body names no locale.

        Returns:
            The notifications to show.
        """
        locale = request_locale(request.locale if request else None, accept_language)
        items = claim_native(job_store.engine, user.username, locale)
        return NativeNotificationClaim(
            items=[NativeNotificationItem(id=i.id, title=i.title, body=i.body, url=i.url, tag=i.tag) for i in items]
        )

    return router
