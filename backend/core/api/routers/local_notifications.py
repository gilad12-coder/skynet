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
from ...notifications.comms import mailable, resolve_email
from ...notifications.native import claim_native, confirm_native
from ...notifications.preferences import clean_held_channels, lock_preferences, merge_grid
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
    macos_held: bool = Field(description="Whether non-urgent macOS notifications wait the hold.")


class MacOSCellsUpdate(BaseModel):
    grid: dict[EventTypeValue, bool] = Field(
        default_factory=dict, description="macOS cells to change; others keep their value."
    )
    held: bool | None = Field(default=None, description="Whether macOS joins the held channels; None keeps it.")


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


class NativeNotificationConfirmRequest(BaseModel):
    ids: list[str] = Field(max_length=100, description="Ids of claimed notifications the app showed.")


class NativeNotificationConfirm(BaseModel):
    confirmed: int = Field(description="How many deliveries turned sent.")


def _channel_states(username: str) -> dict[str, bool]:
    """Report which delivery channels work on this Mac.

    A hosted channel works when this Mac has its own setup for it (SMTP,
    VAPID keys, a Slack app); a hosted-account link (SKY-124) does not exist yet.
    Email also needs an address a relay can deliver to.

    Args:
        username: The signed-in local user.

    Returns:
        Delivery channel -> available, the hosted ones first.
    """
    address = resolve_email(username)
    return {
        EMAIL: email_configured() and address is not None and mailable(address),
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


def _local_state(username: str, row: NotificationPreferenceModel | None) -> LocalNotificationChannels:
    """Render the channel states and the caller's macOS settings.

    Args:
        username: The signed-in local user.
        row: The stored preferences, or ``None``.

    Returns:
        The channel states, the macOS column and whether macOS is held.
    """
    held = clean_held_channels(row.held_channels if row is not None else None)
    return LocalNotificationChannels(
        channels=_channel_states(username), macos=_macos_cells(row), macos_held=MACOS in held
    )


def create_local_notifications_router(*, job_store) -> APIRouter:
    """Build the Mac app's notification router.

    Args:
        job_store: Job-store instance whose ORM engine holds notifications and preferences.

    Returns:
        A router exposing the channel states, the macOS cells, and the native claim and confirm.
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
            return _local_state(user.username, session.get(NotificationPreferenceModel, user.username))

    @router.patch("/local/notifications/macos", include_in_schema=False)
    def update_macos_cells(body: MacOSCellsUpdate, user: AuthenticatedUserDep) -> LocalNotificationChannels:
        """Change the caller's macOS cells and whether macOS is held.

        Args:
            body: The cells to change, and the hold choice.
            user: The signed-in local user.

        Returns:
            The channel states and the macOS settings after the change.
        """
        with Session(job_store.engine) as session:
            row = lock_preferences(session, user.username)
            if body.grid:
                grid = merge_grid(row.channel_grid)
                for event, on in body.grid.items():
                    grid[event][MACOS] = on
                row.channel_grid = merge_grid(grid)
            if body.held is not None:
                others = [ch for ch in clean_held_channels(row.held_channels) if ch != MACOS]
                row.held_channels = list(clean_held_channels([*others, MACOS] if body.held else others))
            row.updated_at = datetime.now(UTC)
            session.commit()
            session.refresh(row)
            return _local_state(user.username, row)

    @router.post("/local/notifications/native/claim", include_in_schema=False)
    def claim_native_notifications(
        user: AuthenticatedUserDep,
        request: NativeNotificationClaimRequest | None = None,
        accept_language: AcceptLanguageDep = None,
    ) -> NativeNotificationClaim:
        """Lease the caller's queued macOS notifications to the Mac app.

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

    @router.post("/local/notifications/native/confirm", include_in_schema=False)
    def confirm_native_notifications(
        body: NativeNotificationConfirmRequest, user: AuthenticatedUserDep
    ) -> NativeNotificationConfirm:
        """Mark the claimed notifications the Mac app showed as sent.

        Args:
            body: The ids the app showed.
            user: The signed-in local user.

        Returns:
            How many deliveries turned sent.
        """
        return NativeNotificationConfirm(confirmed=confirm_native(job_store.engine, user.username, body.ids))

    return router
