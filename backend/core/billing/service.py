"""Stripe-backed billing service: customers, checkout, subscriptions, webhooks.

This module is the only place that talks to Stripe. The web app calls the
billing router, which delegates here. Stripe is the source of truth for money
(charges and subscription state); the local ``billing_customers`` /
``credit_ledger`` tables are a synced cache plus an audit trail, reconciled by
:meth:`StripeBillingService.handle_webhook` on every event Stripe delivers.

Reads (the wallet) work whether or not Stripe is configured, so a deploy
without keys degrades to a read-only free tier. Mutations (checkout, subscribe,
portal) require ``settings.is_stripe_configured`` and raise
``DomainError("billing.not_configured", 503)`` otherwise — never a 500.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from typing import Any

import stripe
from sqlalchemy.orm import Session

from ..api.errors import DomainError
from ..config import settings
from ..storage.models import (
    BillingCustomerModel,
    BillingWebhookEventModel,
    CreditLedgerModel,
)

# Credits granted per one-time pack. Mirrors the frontend CREDIT_PACKS catalog;
# the dollar price lives in Stripe (the price id), the credits granted live here.
PACK_CREDITS: dict[str, int] = {"starter": 500, "plus": 2200, "pro": 6500}

# Renewing allowance that keeps the free tier usable on mini models.
FREE_GRANT_CREDITS = 200

# The free grant rolls on a per-user 30-day window rather than a calendar month,
# so resets scatter across the month instead of all landing on the 1st. The
# window is non-cumulative: a reset tops back up to a flat FREE_GRANT_CREDITS and
# any leftover expires (no banking). Evaluated lazily on wallet read / debit.
GRANT_WINDOW_DAYS = 30

# Prefix on the placeholder ``stripe_customer_id`` of a billing row created by a
# local debit for an account that never reached Stripe. ``get_or_create_customer``
# treats such a row as having no real Stripe customer yet and provisions one.
LOCAL_CUSTOMER_PREFIX = "local:"

# Credits charged per this many run tokens. One credit is $0.01; the markup that
# protects margin lives in this mapping (and the Stripe per-unit price), not in
# the catalog, so it is re-priceable without touching credit counts elsewhere.
TOKENS_PER_CREDIT = 1000

# One Stripe meter unit bills 1000 tokens. The metered price holds the dollar
# rate per unit (see scripts/provision_stripe.py), so the markup is re-priced in
# Stripe without code changes; this only fixes the token-to-unit granularity.
METER_UNIT_TOKENS = 1000

# Stripe subscription statuses that entitle an account to the frontier catalog.
_ACTIVE_SUBSCRIPTION_STATUSES = frozenset({"active", "trialing", "past_due"})


@dataclass(frozen=True)
class LedgerRow:
    """One usage-ledger entry as the wallet UI consumes it.

    ``credits`` is signed (negative for a spend), ``model`` is the model id for a
    run row or ``None`` for a top-up/grant, and ``at`` is an ISO-8601 instant.
    """

    id: str
    at: str
    label: str
    model: str | None
    credits: int
    kind: str


@dataclass(frozen=True)
class WalletSnapshot:
    """The account's billing state as a single read for the wallet surfaces."""

    paid_balance_credits: int
    free_grant_remaining: int
    free_grant_total: int
    free_grant_resets_at: str
    premium_active: bool
    subscription_status: str | None
    subscription_current_period_end: str | None
    usage: list[LedgerRow] = field(default_factory=list)


def credits_for_tokens(total_tokens: int) -> int:
    """Convert a run's token total to the credits it costs, rounding up.

    A partial credit's worth of tokens still costs a whole credit, so a run that
    consumed any tokens at all is never billed zero. The rate
    (:data:`TOKENS_PER_CREDIT`) carries the markup and is re-priceable here.

    Args:
        total_tokens: Tokens the run consumed; non-positive yields ``0``.

    Returns:
        The non-negative credit cost of the run.
    """
    if total_tokens <= 0:
        return 0
    return -(-total_tokens // TOKENS_PER_CREDIT)


def _grant_window_end(now: datetime) -> datetime:
    """Return the instant the free grant next tops up, a fixed window past ``now``.

    Args:
        now: Reference instant the window is anchored to.

    Returns:
        ``now`` advanced by :data:`GRANT_WINDOW_DAYS`, in UTC.
    """
    return now + timedelta(days=GRANT_WINDOW_DAYS)


class StripeBillingService:
    """Mediates between the billing API, the billing tables, and Stripe."""

    def __init__(self, *, engine: Any) -> None:
        """Bind the service to the ORM engine backing the billing tables.

        Args:
            engine: SQLAlchemy engine (``job_store.engine``) used for every
                billing-table session. Stripe itself is configured lazily, so
                constructing the service never requires Stripe credentials.
        """
        self._engine = engine

    def _resolve_grant(self, customer: BillingCustomerModel | None, now: datetime) -> int:
        """Apply the lazy rolling free-grant reset and return the current remaining.

        Seeds an unseeded row (NULL window — a new account or one created before
        these columns existed) to a full grant anchored ``GRANT_WINDOW_DAYS`` out.
        When the window has elapsed, tops the grant back up to a flat
        :data:`FREE_GRANT_CREDITS` (leftover expires — non-cumulative) and advances
        the anchor. Mutates ``customer`` in place; the caller commits. A missing
        row (``None``) is treated as a full grant without persisting anything — the
        row is created on the first real mutation (debit / top-up).

        Args:
            customer: The account's billing row, or ``None`` when it has none yet.
            now: Reference instant for the window comparison.

        Returns:
            Credits remaining in the account's current free grant.
        """
        if customer is None:
            return FREE_GRANT_CREDITS
        if customer.grant_reset_at is None or customer.grant_remaining is None:
            customer.grant_remaining = FREE_GRANT_CREDITS
            customer.grant_reset_at = _grant_window_end(now)
            customer.updated_at = now
            return FREE_GRANT_CREDITS
        reset_at = customer.grant_reset_at
        if reset_at.tzinfo is None:
            reset_at = reset_at.replace(tzinfo=UTC)
        if now > reset_at:
            customer.grant_remaining = FREE_GRANT_CREDITS
            customer.grant_reset_at = _grant_window_end(now)
            customer.updated_at = now
        return int(customer.grant_remaining)

    def _stripe(self) -> Any:
        """Return the ``stripe`` module configured with the secret key.

        Returns:
            The configured ``stripe`` module.

        Raises:
            DomainError: 503 when no Stripe secret key is configured.
        """
        if settings.stripe_secret_key is None:
            raise DomainError("billing.not_configured", status=503)
        stripe.api_key = settings.stripe_secret_key.get_secret_value()
        return stripe

    def _return_url(self, status: str) -> str:
        """Build a Checkout/portal return URL on the public app origin.

        Args:
            status: Query value appended as ``?status=`` (``success``/``cancel``).

        Returns:
            An absolute URL back to the in-app upgrade surface.
        """
        return f"{settings.app_public_url.rstrip('/')}/upgrade?status={status}"

    def get_or_create_customer(self, username: str) -> str:
        """Return the account's Stripe customer id, creating it on first use.

        Persists the ``username -> stripe_customer_id`` mapping so a returning
        buyer reuses one Stripe customer (and one saved card / portal history).

        Args:
            username: Lowercased-email identity the customer is billed under.

        Returns:
            The Stripe customer id (``cus_…``).
        """
        with Session(self._engine) as session:
            row = session.get(BillingCustomerModel, username)
            if row is not None and not row.stripe_customer_id.startswith(LOCAL_CUSTOMER_PREFIX):
                return row.stripe_customer_id
        stripe_mod = self._stripe()
        customer = stripe_mod.Customer.create(email=username, metadata={"username": username})
        now = datetime.now(UTC)
        with Session(self._engine) as session:
            existing = session.get(BillingCustomerModel, username)
            if existing is not None:
                # A local debit may have created a placeholder row before the
                # account reached Stripe; upgrade it in place to the real id so the
                # accrued grant/balance carry over.
                if existing.stripe_customer_id.startswith(LOCAL_CUSTOMER_PREFIX):
                    existing.stripe_customer_id = customer.id
                    existing.updated_at = now
                    session.commit()
                    return customer.id
                return existing.stripe_customer_id
            session.add(
                BillingCustomerModel(
                    username=username,
                    stripe_customer_id=customer.id,
                    credit_balance=0,
                    created_at=now,
                    updated_at=now,
                )
            )
            session.commit()
        return customer.id

    def create_pack_checkout(self, username: str, pack_id: str) -> str:
        """Create a one-time Checkout Session for a credit pack and return its URL.

        Args:
            username: Buyer identity; stamped into session metadata so the
                webhook can credit the right account.
            pack_id: One of :data:`PACK_CREDITS` (``starter``/``plus``/``pro``).

        Returns:
            The hosted Stripe Checkout URL to redirect the buyer to.

        Raises:
            DomainError: 400 when ``pack_id`` is unknown or its price id is
                unconfigured; 503 when Stripe is not configured.
        """
        price_id = settings.stripe_pack_price_ids.get(pack_id, "")
        credits = PACK_CREDITS.get(pack_id, 0)
        if not price_id or credits <= 0:
            raise DomainError("billing.unknown_pack", status=400, pack_id=pack_id)
        stripe_mod = self._stripe()
        customer_id = self.get_or_create_customer(username)
        metadata = {"username": username, "pack_id": pack_id, "credits": str(credits)}
        checkout = stripe_mod.checkout.Session.create(
            customer=customer_id,
            mode="payment",
            line_items=[{"price": price_id, "quantity": 1}],
            success_url=self._return_url("success"),
            cancel_url=self._return_url("cancel"),
            client_reference_id=username,
            metadata=metadata,
            payment_intent_data={"metadata": metadata},
        )
        return str(checkout.url)

    def create_subscription_checkout(self, username: str) -> str:
        """Create a Checkout Session for the Premium subscription and return its URL.

        When a metered overage price is configured it is added as a second,
        quantity-less line item so the subscription can be billed for token usage.

        Args:
            username: Subscriber identity, stamped into session metadata.

        Returns:
            The hosted Stripe Checkout URL for the recurring subscription.

        Raises:
            DomainError: 503 when Stripe / the Premium price id is unconfigured.
        """
        price_id = settings.stripe_price_premium
        if not price_id:
            raise DomainError("billing.not_configured", status=503)
        stripe_mod = self._stripe()
        customer_id = self.get_or_create_customer(username)
        line_items: list[dict[str, Any]] = [{"price": price_id, "quantity": 1}]
        # The metered overage price rides on the same subscription so per-run token
        # usage (reported via report_run_usage) actually bills the subscriber. A
        # metered price is quantity-less — passing a quantity makes Checkout reject it.
        metered_price = settings.stripe_price_metered
        if metered_price:
            line_items.append({"price": metered_price})
        checkout = stripe_mod.checkout.Session.create(
            customer=customer_id,
            mode="subscription",
            line_items=line_items,
            success_url=self._return_url("success"),
            cancel_url=self._return_url("cancel"),
            client_reference_id=username,
            metadata={"username": username},
        )
        return str(checkout.url)

    def create_billing_portal(self, username: str) -> str:
        """Create a Stripe Billing Portal session and return its URL.

        The portal is where a subscriber updates their card, views invoices, or
        cancels Premium — Stripe hosts it, so no billing-management UI is built.

        Args:
            username: Account whose portal session is created.

        Returns:
            The hosted Billing Portal URL.

        Raises:
            DomainError: 503 when Stripe is not configured.
        """
        stripe_mod = self._stripe()
        customer_id = self.get_or_create_customer(username)
        portal = stripe_mod.billing_portal.Session.create(
            customer=customer_id, return_url=self._return_url("portal")
        )
        return str(portal.url)

    def get_wallet(self, username: str) -> WalletSnapshot:
        """Return the account's wallet snapshot from the billing tables.

        A pure DB read — no Stripe call — so it serves even when Stripe is
        unconfigured (balance 0, no subscription). The free grant reflects real
        spend: run completions debit it via :meth:`debit_run`, and the rolling,
        non-cumulative reset is lazy-evaluated here — if the window has elapsed
        the grant tops back up to a flat allowance and the anchor advances (any
        leftover expires). Paid (Premium) accounts anchor the reset to the Stripe
        subscription period instead of the rolling window. A read that mutates an
        existing row (seed or reset) is persisted; a brand-new account reads a
        full grant without creating a row until its first real mutation.

        Args:
            username: Account to summarize.

        Returns:
            A :class:`WalletSnapshot` of paid balance, free grant, subscription
            state, and the most recent ledger rows.
        """
        now = datetime.now(UTC)
        with Session(self._engine) as session:
            customer = session.get(BillingCustomerModel, username)
            grant_remaining = self._resolve_grant(customer, now)
            # Capture the seed/reset mutation before the ledger query autoflushes
            # it — once flushed, ``is_modified`` reads clean and the commit below
            # would be skipped, dropping the reset on session close.
            grant_dirty = customer is not None and session.is_modified(customer)
            rows = (
                session.query(CreditLedgerModel)
                .filter(CreditLedgerModel.username == username)
                .order_by(CreditLedgerModel.created_at.desc())
                .limit(15)
                .all()
            )
            usage = [
                LedgerRow(
                    id=str(row.id),
                    at=row.created_at.isoformat(),
                    label=row.description or row.kind,
                    model=row.model,
                    credits=row.delta_credits,
                    kind=row.kind,
                )
                for row in rows
            ]
            status = customer.subscription_status if customer else None
            period_end = (
                customer.subscription_current_period_end
                if customer and customer.subscription_current_period_end
                else None
            )
            premium_active = status in _ACTIVE_SUBSCRIPTION_STATUSES if status else False
            # Paid accounts anchor the grant top-up to their subscription period;
            # everyone else to the rolling per-user window (``grant_reset_at``).
            if premium_active and period_end is not None:
                resets_at = period_end
            elif customer is not None and customer.grant_reset_at is not None:
                resets_at = customer.grant_reset_at
            else:
                resets_at = _grant_window_end(now)
            if grant_dirty:
                session.commit()
            return WalletSnapshot(
                paid_balance_credits=customer.credit_balance if customer else 0,
                free_grant_remaining=grant_remaining,
                free_grant_total=FREE_GRANT_CREDITS,
                free_grant_resets_at=resets_at.isoformat(),
                premium_active=premium_active,
                subscription_status=status,
                subscription_current_period_end=period_end.isoformat() if period_end else None,
                usage=usage,
            )

    def spendable_credits(self, username: str) -> int:
        """Return the account's total spendable credits (free grant + paid balance).

        Applies the lazy rolling grant reset first, so an account whose window
        elapsed reads its topped-up grant rather than a stale figure. A mutated
        row (seed or reset) is persisted. This is the figure the submit gate
        checks: ``> 0`` means a managed run may start. A brand-new account reads a
        full grant without a row being created.

        Args:
            username: Account to read.

        Returns:
            Free-grant remaining plus purchased balance, never negative.
        """
        now = datetime.now(UTC)
        with Session(self._engine) as session:
            customer = session.get(BillingCustomerModel, username)
            grant_remaining = self._resolve_grant(customer, now)
            paid = int(customer.credit_balance) if customer is not None else 0
            if customer is not None and session.is_modified(customer):
                session.commit()
        return max(grant_remaining + paid, 0)

    def debit_run(
        self, username: str, total_tokens: int, *, model: str | None, description: str
    ) -> int:
        """Charge a finished run's credit cost to the account, free grant first.

        Writes one signed negative ``run`` row to ``credit_ledger`` and draws the
        cost from the free grant before the purchased balance, mirroring how
        :meth:`get_wallet` reports spendable credits (grant then paid). The rolling
        grant reset is applied first so a run that completes after the window
        elapsed bills against the topped-up grant. Idempotency is the caller's
        responsibility: the worker debits inside its once-only completion claim, so
        a redelivered/re-run job never double-charges. A run costing zero credits
        (no tokens, or under one credit's worth) writes nothing.

        Args:
            username: Account the run is billed to.
            total_tokens: Tokens the run consumed; converted via
                :func:`credits_for_tokens`.
            model: Model id stamped on the ledger row, or ``None``.
            description: Human label for the ledger row (typically the run name).

        Returns:
            The credit cost charged (``0`` when nothing was billed).
        """
        cost = credits_for_tokens(total_tokens)
        if cost <= 0:
            return 0
        now = datetime.now(UTC)
        with Session(self._engine) as session:
            customer = session.get(BillingCustomerModel, username)
            if customer is None:
                # A run can finish for an account that never touched Stripe; seed a
                # customer-less billing row so the debit lands and the grant tracks.
                # ``stripe_customer_id`` is uniquely indexed, so the placeholder is
                # keyed on the username to avoid colliding across free accounts; the
                # real id replaces it the first time the account reaches Stripe.
                customer = BillingCustomerModel(
                    username=username,
                    stripe_customer_id=f"{LOCAL_CUSTOMER_PREFIX}{username}",
                    credit_balance=0,
                    created_at=now,
                    updated_at=now,
                )
                session.add(customer)
            self._resolve_grant(customer, now)
            from_grant = min(int(customer.grant_remaining or 0), cost)
            customer.grant_remaining = int(customer.grant_remaining or 0) - from_grant
            customer.credit_balance = int(customer.credit_balance) - (cost - from_grant)
            customer.updated_at = now
            session.add(
                CreditLedgerModel(
                    username=username,
                    delta_credits=-cost,
                    kind="run",
                    description=description or "Run",
                    model=model,
                )
            )
            session.commit()
        return cost

    def handle_webhook(self, payload: bytes, sig_header: str | None) -> None:
        """Verify and apply a Stripe webhook event, exactly once.

        Records the event id before applying its effect in the same transaction,
        so a redelivered event (Stripe guarantees at-least-once) is a no-op
        instead of a double-credit.

        Args:
            payload: Raw request body bytes (signature is over the raw bytes).
            sig_header: The ``Stripe-Signature`` header value.

        Raises:
            DomainError: 503 when the webhook secret is unconfigured; 400 when
                the signature does not verify.
        """
        if settings.stripe_webhook_secret is None:
            raise DomainError("billing.not_configured", status=503)
        stripe_mod = self._stripe()
        try:
            event = stripe_mod.Webhook.construct_event(
                payload, sig_header or "", settings.stripe_webhook_secret.get_secret_value()
            )
        except (ValueError, stripe.SignatureVerificationError) as exc:
            raise DomainError("billing.webhook_invalid", status=400) from exc
        event_id = str(event["id"])
        with Session(self._engine) as session:
            if session.get(BillingWebhookEventModel, event_id) is not None:
                return
            session.add(
                BillingWebhookEventModel(event_id=event_id, event_type=str(event["type"]))
            )
            self._apply_event(session, event)
            session.commit()

    def _apply_event(self, session: Session, event: Any) -> None:
        """Dispatch a verified event to its handler; unknown types are no-ops.

        Args:
            session: Open session; the caller commits (event row + effect land
                atomically).
            event: The verified Stripe event object.
        """
        event_type = str(event["type"])
        obj = event["data"]["object"]
        if event_type == "checkout.session.completed":
            self._on_checkout_completed(session, str(event["id"]), obj)
        elif event_type in (
            "customer.subscription.created",
            "customer.subscription.updated",
            "customer.subscription.deleted",
        ):
            self._on_subscription_change(session, obj)

    def _on_checkout_completed(self, session: Session, event_id: str, obj: Any) -> None:
        """Credit a completed one-time pack purchase to the buyer's balance.

        Subscription-mode sessions are ignored here — the subscription's own
        ``customer.subscription.created`` event carries the authoritative state.

        Args:
            session: Open session (caller commits).
            event_id: Stripe event id, recorded on the ledger row for traceability.
            obj: The Checkout Session object from the event.
        """
        if obj.get("mode") != "payment" or obj.get("payment_status") != "paid":
            return
        metadata = obj.get("metadata") or {}
        username = str(metadata.get("username") or obj.get("client_reference_id") or "").lower()
        credits = int(metadata.get("credits") or 0)
        pack_id = str(metadata.get("pack_id") or "")
        if not username or credits <= 0:
            return
        customer = session.get(BillingCustomerModel, username)
        if customer is None:
            customer = BillingCustomerModel(
                username=username,
                stripe_customer_id=str(obj.get("customer") or ""),
                credit_balance=0,
            )
            session.add(customer)
        customer.credit_balance = int(customer.credit_balance) + credits
        customer.updated_at = datetime.now(UTC)
        session.add(
            CreditLedgerModel(
                username=username,
                delta_credits=credits,
                kind="topup",
                description=f"Top-up · {pack_id}" if pack_id else "Top-up",
                stripe_event_id=event_id,
            )
        )

    def _on_subscription_change(self, session: Session, obj: Any) -> None:
        """Sync a subscription's status onto the matching customer row.

        Args:
            session: Open session (caller commits).
            obj: The Subscription object from the event.
        """
        customer_id = str(obj.get("customer") or "")
        if not customer_id:
            return
        row = (
            session.query(BillingCustomerModel)
            .filter(BillingCustomerModel.stripe_customer_id == customer_id)
            .one_or_none()
        )
        if row is None:
            return
        items = (obj.get("items") or {}).get("data") or []
        price_id = items[0]["price"]["id"] if items else None
        # current_period_end sits on the subscription in older API versions and on
        # the subscription item in newer ones (2025-03+); read whichever is present.
        period_end_ts = obj.get("current_period_end") or (
            items[0].get("current_period_end") if items else None
        )
        row.subscription_status = str(obj.get("status") or "")
        row.subscription_price_id = price_id
        row.subscription_current_period_end = (
            datetime.fromtimestamp(int(period_end_ts), tz=UTC) if period_end_ts else None
        )
        row.updated_at = datetime.now(UTC)

    def report_run_usage(self, username: str, total_tokens: int) -> None:
        """Meter a finished run's token usage to Stripe Billing Meters.

        Called once per successful optimization by the worker (see
        :class:`core.worker.engine.BackgroundWorker`). Converts the run's token
        total to whole meter units (:data:`METER_UNIT_TOKENS` tokens each) and
        pushes a meter event Stripe aggregates against the account's metered
        price — the usage-based overage path. Only Premium subscribers whose
        subscription carries the metered price are actually charged; for everyone
        else the event is recorded as analytics and never billed.

        Lookup-only by design: usage is reported solely for accounts that already
        have a billing customer (bought a pack or subscribed). A user who never
        touched billing gets no Stripe customer created here, avoiding customer
        sprawl for the free tier that would never be billed anyway.

        Args:
            username: Account the usage is billed to.
            total_tokens: Tokens the run consumed; ignored when it rounds to less
                than one meter unit, or when Stripe is unconfigured.
        """
        if total_tokens <= 0 or settings.stripe_secret_key is None:
            return
        units = total_tokens // METER_UNIT_TOKENS
        if units <= 0:
            return
        with Session(self._engine) as session:
            customer = session.get(BillingCustomerModel, username)
            customer_id = customer.stripe_customer_id if customer else None
        if not customer_id:
            return
        stripe_mod = self._stripe()
        stripe_mod.billing.MeterEvent.create(
            event_name=settings.stripe_meter_event_name,
            payload={"stripe_customer_id": customer_id, "value": str(units)},
        )
