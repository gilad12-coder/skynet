"""Managed-credit billing routes: wallet, checkout, subscription, portal, webhook.

Backs the in-app wallet, the upgrade/paywall page, and the Premium subscription.
Authenticated routes resolve the caller via the shared session-JWT/PAT
dependency and key every operation on ``user.username`` (the lowercased email).
The webhook route is deliberately unauthenticated — Stripe can't present a
bearer token — and instead verifies the event's signature in the service.

Wallet reads succeed even when Stripe is unconfigured (free-tier zeros);
mutations raise ``DomainError("billing.not_configured", 503)``.
"""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, Request
from pydantic import BaseModel, Field

from ...billing import StripeBillingService
from ..auth import AuthenticatedUser, get_authenticated_user

AuthenticatedUserDep = Annotated[AuthenticatedUser, Depends(get_authenticated_user)]


class FreeGrantResponse(BaseModel):
    """The renewing monthly mini-model allowance."""

    credits_remaining: int = Field(description="Credits left in the current monthly grant.")
    credits_total: int = Field(description="Full monthly grant size.")
    resets_at: str = Field(description="ISO-8601 instant the grant tops back up.")


class UsageEntryResponse(BaseModel):
    """One row of the credit usage ledger."""

    id: str = Field(description="Stable row id.")
    at: str = Field(description="ISO-8601 instant the entry was recorded.")
    label: str = Field(description="Human label for the row (a run name, 'Top-up', etc.).")
    model: str | None = Field(default=None, description="Model id for a run row, else null.")
    credits: int = Field(description="Signed credit delta: negative for a spend.")
    kind: str = Field(description="Entry kind: 'run', 'topup', or 'grant'.")


class WalletResponse(BaseModel):
    """The caller's wallet: purchased balance, free grant, subscription, recent ledger."""

    paid_balance_credits: int = Field(description="Purchased credits — the frontier-access gate.")
    free_grant: FreeGrantResponse
    premium_active: bool = Field(description="Whether an active Premium subscription is in effect.")
    subscription_status: str | None = Field(
        default=None, description="Raw Stripe subscription status, or null when none."
    )
    subscription_current_period_end: str | None = Field(
        default=None, description="ISO-8601 end of the current paid period, or null."
    )
    usage: list[UsageEntryResponse] = Field(
        default_factory=list, description="Most-recent-first ledger rows."
    )


# Request to start a credit-pack checkout. pack_id is one of starter/plus/pro.
class CheckoutRequest(BaseModel):
    pack_id: str = Field(description="Credit pack to buy: 'starter', 'plus', or 'pro'.")


class CheckoutSessionResponse(BaseModel):
    """A hosted Stripe URL the client should redirect the browser to."""

    url: str = Field(description="Absolute Stripe-hosted Checkout or portal URL.")


class WebhookAck(BaseModel):
    """Acknowledgement that a webhook event was received and applied."""

    received: bool = Field(description="Always true once the event was verified and applied.")


def create_billing_router(*, job_store) -> APIRouter:
    """Build the managed-credit billing router.

    Args:
        job_store: Job-store instance whose ORM engine backs the billing tables.

    Returns:
        A FastAPI ``APIRouter`` exposing wallet, checkout, subscribe, portal, and
        the Stripe webhook receiver.
    """
    router = APIRouter()
    service = StripeBillingService(engine=job_store.engine)

    @router.get(
        "/billing/wallet",
        response_model=WalletResponse,
        summary="Return the caller's credit wallet and subscription state",
    )
    def get_wallet(user: AuthenticatedUserDep) -> WalletResponse:
        """Return the caller's purchased balance, free grant, subscription, and ledger.

        Args:
            user: Authenticated caller whose wallet is read.

        Returns:
            The wallet snapshot; free-tier zeros when the caller has no billing row.
        """
        snapshot = service.get_wallet(user.username)
        return WalletResponse(
            paid_balance_credits=snapshot.paid_balance_credits,
            free_grant=FreeGrantResponse(
                credits_remaining=snapshot.free_grant_remaining,
                credits_total=snapshot.free_grant_total,
                resets_at=snapshot.free_grant_resets_at,
            ),
            premium_active=snapshot.premium_active,
            subscription_status=snapshot.subscription_status,
            subscription_current_period_end=snapshot.subscription_current_period_end,
            usage=[
                UsageEntryResponse(
                    id=row.id,
                    at=row.at,
                    label=row.label,
                    model=row.model,
                    credits=row.credits,
                    kind=row.kind,
                )
                for row in snapshot.usage
            ],
        )

    @router.post(
        "/billing/checkout",
        response_model=CheckoutSessionResponse,
        summary="Start a Stripe Checkout session for a credit pack",
    )
    def create_checkout(body: CheckoutRequest, user: AuthenticatedUserDep) -> CheckoutSessionResponse:
        """Create a one-time Checkout session for a credit pack.

        Args:
            body: The pack to buy.
            user: Authenticated buyer; credits land on their account via webhook.

        Returns:
            The hosted Checkout URL to redirect the buyer to.
        """
        url = service.create_pack_checkout(user.username, body.pack_id)
        return CheckoutSessionResponse(url=url)

    @router.post(
        "/billing/subscribe",
        response_model=CheckoutSessionResponse,
        summary="Start a Stripe Checkout session for the Premium subscription",
    )
    def create_subscription(user: AuthenticatedUserDep) -> CheckoutSessionResponse:
        """Create a subscription Checkout session for Premium.

        Args:
            user: Authenticated subscriber.

        Returns:
            The hosted Checkout URL for the recurring subscription.
        """
        url = service.create_subscription_checkout(user.username)
        return CheckoutSessionResponse(url=url)

    @router.post(
        "/billing/portal",
        response_model=CheckoutSessionResponse,
        summary="Open the Stripe Billing Portal for the caller",
    )
    def open_portal(user: AuthenticatedUserDep) -> CheckoutSessionResponse:
        """Create a Stripe Billing Portal session (manage card / invoices / cancel).

        Args:
            user: Authenticated account whose portal session is created.

        Returns:
            The hosted Billing Portal URL.
        """
        url = service.create_billing_portal(user.username)
        return CheckoutSessionResponse(url=url)

    @router.post(
        "/billing/webhook",
        response_model=WebhookAck,
        include_in_schema=False,
        summary="Receive and apply a Stripe webhook event",
    )
    async def stripe_webhook(request: Request) -> WebhookAck:
        """Verify a Stripe webhook signature and apply the event idempotently.

        Unauthenticated by design: authenticity comes from the Stripe signature
        over the raw request body, not a bearer token.

        Args:
            request: Raw request; its body and ``Stripe-Signature`` header are
                read directly (the signature is over the unparsed bytes).

        Returns:
            An acknowledgement once the event is verified and applied.
        """
        payload = await request.body()
        signature = request.headers.get("stripe-signature")
        service.handle_webhook(payload, signature)
        return WebhookAck(received=True)

    return router
