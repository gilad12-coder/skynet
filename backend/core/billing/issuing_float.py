"""Keep the Stripe Issuing balance funded so the provider card never declines.

Skynet pays its upstream providers (OpenRouter Auto Top-Up and friends) with a
Stripe Issuing virtual card. An Issuing card spends only from the account's
separate Issuing balance, so this module keeps that balance between a floor and
a target without anyone touching the dashboard.

Each check reads ``GET /v1/balance``. When the Issuing balance plus our own
still-pending top-ups falls below ``ISSUING_BALANCE_FLOOR_CREDITS``, it refills
up to ``ISSUING_BALANCE_TARGET_CREDITS``:

1. First from the Stripe payments balance (the money customers paid for
   credits) through ``POST /v1/balance_transfers``. Instant in the US, but the
   endpoint is a Stripe private beta, so a refusal just falls through.
2. Then from the linked bank account through ``POST /v1/topups`` with
   ``destination_balance=issuing``. Up to five business days to land, which is
   why pending top-ups count toward the balance: otherwise every tick would
   pull the same shortfall again.

Any failure notifies the operator through the same channels as the OpenRouter
float monitor, behind its own cooldown. Nothing here ever raises into a caller.
"""

from __future__ import annotations

import logging
import threading
import time
from dataclasses import dataclass
from typing import Any

import stripe
from redis.exceptions import RedisError
from sqlalchemy import text

from ..api.alerts import send_alert
from ..api.email_sender import email_configured, send_email
from ..api.rate_limit import shared_redis_client
from ..config import settings

logger = logging.getLogger("skynet.billing.issuing_float")

# Continues the 7421370000xx advisory-lock series (openrouter_float uses ...05).
ISSUING_FUNDING_SWEEP_LOCK_KEY = 742137000006
_ALERT_COOLDOWN_REDIS_KEY = "skynet:issuing-float:alert-cooldown"
_MIN_SWEEP_INTERVAL_SECONDS = 60.0
_CURRENCY = "usd"
# Tags the top-ups this module creates so only they count as pending funding.
_TOPUP_METADATA = {"skynet_purpose": "issuing_float"}

_local_cooldown_lock = threading.Lock()
_local_cooldown_until = 0.0


@dataclass(frozen=True)
class FundingResult:
    """Outcome of one Issuing funding check, all amounts in credits (1 credit = 1 cent).

    ``issuing_credits`` is the available Issuing balance before this check and
    ``pending_credits`` our top-ups still in flight. ``transferred_credits``
    and ``topped_up_credits`` are what this check moved; ``error`` is set when
    a shortfall could not be fully covered.
    """

    issuing_credits: int
    pending_credits: int
    transferred_credits: int = 0
    topped_up_credits: int = 0
    error: str | None = None


def funding_enabled() -> bool:
    """Return whether the Issuing funding loop is fully configured.

    Returns:
        True when a Stripe key is set and the target sits above a positive floor.
    """
    floor = settings.issuing_balance_floor_credits
    return settings.stripe_secret_key is not None and floor > 0 and settings.issuing_balance_target_credits > floor


def _client() -> stripe.StripeClient:
    """Build a Stripe client from the configured secret key.

    Returns:
        A client bound to ``STRIPE_SECRET_KEY``.
    """
    assert settings.stripe_secret_key is not None
    return stripe.StripeClient(settings.stripe_secret_key.get_secret_value())


def _usd(entries: Any) -> int:
    """Sum the USD amounts in a Stripe balance list.

    Args:
        entries: A ``[{amount, currency}, ...]`` list, or ``None``.

    Returns:
        The USD total in cents, ``0`` when absent.
    """
    return sum(int(e["amount"]) for e in entries or [] if e["currency"] == _CURRENCY)


def _pending_topup_credits(client: stripe.StripeClient) -> int:
    """Sum the top-ups this module created that have not landed yet.

    Args:
        client: Stripe client.

    Returns:
        Pending top-up total in cents.
    """
    pending = client.v1.topups.list({"status": "pending", "limit": 100})
    return sum(
        t.amount
        for t in pending.data
        if t.currency == _CURRENCY and (t.metadata or {}).get("skynet_purpose") == _TOPUP_METADATA["skynet_purpose"]
    )


def _transfer_from_payments(client: stripe.StripeClient, amount: int) -> int:
    """Move payments-balance funds into the Issuing balance.

    Args:
        client: Stripe client.
        amount: Cents to move; must not exceed the available payments balance.

    Returns:
        Cents moved, ``0`` when Stripe refused (typically: the account is not in
        the Balance Transfers beta).
    """
    try:
        client.raw_request(
            "post",
            "/v1/balance_transfers",
            amount=amount,
            currency=_CURRENCY,
            source_balance={"type": "payments"},
            destination_balance={"type": "issuing"},
        )
    except stripe.StripeError as exc:
        logger.info("Issuing balance transfer unavailable, falling back to a bank top-up: %s", exc)
        return 0
    return amount


def fund_issuing_once(now: float | None = None) -> FundingResult | None:
    """Refill the Issuing balance to its target when it dips below the floor.

    Args:
        now: Wall-clock override for the top-up idempotency window (tests).

    Returns:
        The funding outcome, or ``None`` when the loop is disabled or the
        balance could not be read.
    """
    if not funding_enabled():
        return None
    client = _client()
    try:
        balance = client.v1.balance.retrieve()
        issuing = _usd((balance.get("issuing") or {}).get("available"))
        payments = _usd(balance.get("available"))
        pending = _pending_topup_credits(client)
    except stripe.StripeError as exc:
        logger.warning("Issuing balance read failed: %s", exc)
        notify_funding_problem(f"Could not read the Stripe balance: {exc}")
        return None

    if issuing + pending >= settings.issuing_balance_floor_credits:
        return FundingResult(issuing_credits=issuing, pending_credits=pending)

    shortfall = settings.issuing_balance_target_credits - issuing - pending
    transferred = _transfer_from_payments(client, min(shortfall, payments)) if payments > 0 else 0
    remaining = shortfall - transferred
    topped_up = 0
    error = None
    if remaining > 0:
        # One idempotency key per hour and amount: a retried tick inside the
        # hour replays the same top-up instead of pulling the bank twice.
        window = int((now if now is not None else time.time()) // 3600)
        try:
            client.v1.topups.create(
                {
                    "amount": remaining,
                    "currency": _CURRENCY,
                    "destination_balance": "issuing",
                    "description": "Skynet provider card funding",
                    "statement_descriptor": "Skynet float",
                    "metadata": _TOPUP_METADATA,
                },
                {"idempotency_key": f"skynet-issuing-topup-{window}-{remaining}"},
            )
            topped_up = remaining
        except stripe.StripeError as exc:
            error = f"Bank top-up of ${remaining / 100:.2f} failed: {exc}"

    result = FundingResult(
        issuing_credits=issuing,
        pending_credits=pending,
        transferred_credits=transferred,
        topped_up_credits=topped_up,
        error=error,
    )
    logger.info(
        "Issuing balance $%.2f below floor: moved $%.2f from payments, requested $%.2f from the bank",
        issuing / 100,
        transferred / 100,
        topped_up / 100,
    )
    if error:
        logger.warning("Issuing funding incomplete: %s", error)
        notify_funding_problem(
            f"Issuing balance is ${issuing / 100:.2f}, below the "
            f"${settings.issuing_balance_floor_credits / 100:.2f} floor.\n{error}\n\n"
            "The provider card will start declining once the Issuing balance hits zero. "
            "Add funds at https://dashboard.stripe.com/balance/overview."
        )
    return result


def _cooldown_allows() -> bool:
    """Claim the funding-alert slot, sharing the window across replicas via Redis.

    Returns:
        True when a notification may be sent now.
    """
    global _local_cooldown_until
    cooldown = settings.openrouter_float_alert_cooldown_seconds
    if cooldown <= 0:
        return True
    client = shared_redis_client()
    if client is not None:
        try:
            return bool(client.set(_ALERT_COOLDOWN_REDIS_KEY, "1", nx=True, ex=int(cooldown)))
        except RedisError as exc:
            logger.debug("Issuing alert cooldown fell back to process-local: %s", exc)
    stamp = time.monotonic()
    with _local_cooldown_lock:
        if stamp < _local_cooldown_until:
            return False
        _local_cooldown_until = stamp + cooldown
        return True


def notify_funding_problem(body: str) -> bool:
    """Send an Issuing funding problem to the alert webhook and operator email.

    Args:
        body: Plain-text description of what failed.

    Returns:
        True when the cooldown allowed a notification to be dispatched.
    """
    try:
        if not _cooldown_allows():
            return False
        subject = "Skynet provider card funding needs attention"
        send_alert(subject, body=body, level="WARNING")
        recipient = settings.openrouter_float_alert_email.strip()
        if recipient and email_configured():
            threading.Thread(
                target=_deliver_email, args=(recipient, subject, body), name="issuing-float-email", daemon=True
            ).start()
        return True
    except Exception:
        logger.exception("Issuing funding notification failed")
        return False


def _deliver_email(recipient: str, subject: str, body: str) -> None:
    """Send the funding alert email, logging (never raising) on failure.

    Args:
        recipient: Operator address.
        subject: Message subject.
        body: Plain-text body.
    """
    try:
        send_email(recipient, subject, body)
    except Exception as exc:
        logger.warning("Issuing funding alert email to %s failed: %s", recipient, exc)


class IssuingFundingSweeper:
    """Run :func:`fund_issuing_once` on an interval, one replica per tick.

    Leader election uses a Postgres transaction-scoped advisory lock, so two
    pods never both see the same shortfall and fund it twice. On other
    dialects (tests / SQLite) the check runs unconditionally.
    """

    def __init__(self, engine: Any, interval_seconds: float | None = None) -> None:
        """Initialize the sweeper.

        Args:
            engine: SQLAlchemy engine the advisory lock is taken on.
            interval_seconds: Override for ``settings.issuing_funding_check_interval_seconds``.
        """
        self._engine = engine
        resolved = interval_seconds if interval_seconds is not None else settings.issuing_funding_check_interval_seconds
        self._interval_seconds = max(_MIN_SWEEP_INTERVAL_SECONDS, float(resolved))
        self._stop_event = threading.Event()
        self._thread: threading.Thread | None = None

    def start(self) -> None:
        """Start the background funding loop."""
        self._thread = threading.Thread(target=self._run, name="issuing-funding-sweeper", daemon=True)
        self._thread.start()

    def stop(self) -> None:
        """Stop the background funding loop."""
        self._stop_event.set()
        if self._thread is not None:
            self._thread.join(timeout=2.0)

    def sweep_once(self) -> FundingResult | None:
        """Win the leader lock and run one funding check.

        Returns:
            The funding outcome, or ``None`` when a peer holds the lock, the
            loop is disabled, or the check failed.
        """
        try:
            if self._engine is not None and self._engine.dialect.name == "postgresql":
                with self._engine.begin() as conn:
                    acquired = conn.execute(
                        text("SELECT pg_try_advisory_xact_lock(:k)"),
                        {"k": ISSUING_FUNDING_SWEEP_LOCK_KEY},
                    ).scalar()
                    if not acquired:
                        return None
                    return fund_issuing_once()
            return fund_issuing_once()
        except Exception:
            logger.warning("Issuing funding sweep failed", exc_info=True)
            return None

    def _run(self) -> None:
        """Run the funding loop until stopped."""
        self.sweep_once()
        while not self._stop_event.wait(self._interval_seconds):
            self.sweep_once()


def start_issuing_funding_sweeper(engine: Any) -> IssuingFundingSweeper | None:
    """Start the Issuing funding loop when it is configured.

    Args:
        engine: SQLAlchemy engine the advisory lock is taken on.

    Returns:
        The started sweeper, or ``None`` when funding is disabled or the
        interval is ``0``; callers should ``stop()`` a returned sweeper on shutdown.
    """
    if settings.issuing_funding_check_interval_seconds <= 0 or not funding_enabled():
        return None
    sweeper = IssuingFundingSweeper(engine)
    sweeper.start()
    return sweeper
