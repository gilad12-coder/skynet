"""Group concurrent chat requests for one model into OpenRouter batches at half price."""

from __future__ import annotations

import json
import logging
import threading
import time
from collections.abc import Callable, Mapping
from concurrent.futures import Future
from dataclasses import dataclass
from decimal import Decimal
from typing import Any
from uuid import uuid4

import httpx

from .operation_pricing import exact_nonnegative

logger = logging.getLogger(__name__)

BATCHES_URL = "https://openrouter.ai/api/v1/batches"
TERMINAL_STATUSES = {"completed", "failed", "expired", "cancelled"}
# Batch-level routing fields; OpenRouter applies one routing to the whole batch.
BATCH_ROUTING_FIELDS = ("only", "data_collection", "zdr")

# Optimizers fire a round of evaluations at once and then wait on all of them,
# so a short window collects the round without delaying a lone call much.
GATHER_SECONDS = 3.0
MAX_BATCH_REQUESTS = 500
POLL_SECONDS = 15.0
MAX_POLL_SECONDS = 60.0
# OpenRouter's only completion window is 24 hours; the extra hour covers
# finalization before a request is treated as lost.
BATCH_DEADLINE_SECONDS = 25 * 3600.0


@dataclass(frozen=True)
class BatchAnswer:
    """One request's outcome in the shape a direct chat call would have returned."""

    status: int
    body: bytes
    interrupted: bool = False


@dataclass
class _Entry:
    """A waiting request, its pricing weights, and the caller's pending answer."""

    custom_id: str
    body: dict[str, Any]
    rates: tuple[Decimal, Decimal]
    future: Future[BatchAnswer]


def _error(code: str, message: str) -> bytes:
    """Encode a relay error body the SDK surfaces like a provider error."""
    return json.dumps({"error": {"type": code, "message": message}}).encode()


def allocate_cost(total: Decimal, weights: list[Decimal]) -> list[Decimal]:
    """Split a batch-level bill across its requests so the parts sum exactly to the whole.

    Args:
        total: The provider's measured charge for the whole batch.
        weights: Each request's relative list-price cost.

    Returns:
        One share per weight; an even split when no request has a weight.
    """
    if not weights:
        return []
    weight_sum = sum(weights, Decimal(0))
    if weight_sum == 0:
        weights = [Decimal(1)] * len(weights)
        weight_sum = Decimal(len(weights))
    shares = [total * weight / weight_sum for weight in weights[:-1]]
    return [*shares, total - sum(shares, Decimal(0))]


_LOST = BatchAnswer(
    502, _error("provider_interrupted", "The batch did not finish or its outcome is unknown."), interrupted=True
)


class BatchCollector:
    """Submit one model's concurrent chat requests together and wait for the batch."""

    def __init__(
        self,
        *,
        api_key: str,
        model: str,
        client: httpx.Client,
        heartbeat: Callable[[], None] | None = None,
        gather_seconds: float = GATHER_SECONDS,
        poll_seconds: float = POLL_SECONDS,
        deadline_seconds: float = BATCH_DEADLINE_SECONDS,
        sleep: Callable[[float], object] | None = None,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        """Bind the collector to one credential and model.

        Args:
            api_key: The OpenRouter credential the batch is billed to.
            model: The single model every request in a batch must use.
            client: HTTP client for submission and polling.
            heartbeat: Called on every poll so the job watchdog sees progress.
            gather_seconds: How long the first request waits for others to join.
            poll_seconds: Initial delay between status checks.
            deadline_seconds: How long to wait before treating a batch as lost.
            sleep: Delay function, replaceable in tests; defaults to a wait that
                ``stop`` interrupts.
            clock: Monotonic clock, replaceable in tests.
        """
        self._api_key = api_key
        self.model = model
        self._client = client
        self._heartbeat = heartbeat
        self._gather_seconds = gather_seconds
        self._poll_seconds = poll_seconds
        self._deadline_seconds = deadline_seconds
        self._stopped = threading.Event()
        self._sleep = sleep or self._stopped.wait
        self._clock = clock
        self._lock = threading.Lock()
        self._pending: list[_Entry] = []
        self._flush_scheduled = False

    def run(self, body: Mapping[str, Any], rates: tuple[Decimal, Decimal]) -> BatchAnswer:
        """Queue one request and block until its batch returns an answer.

        Args:
            body: The final priced chat completions body.
            rates: Prompt and completion list prices, used to share the batch bill.

        Returns:
            The request's answer, with its share of the batch cost in ``usage.cost``.
        """
        if self._stopped.is_set():
            return BatchAnswer(502, _error("batch_rejected", "The run is stopping; the request was not sent."))
        entry = _Entry(f"req-{uuid4().hex}", dict(body), rates, Future())
        with self._lock:
            self._pending.append(entry)
            flush_now = len(self._pending) >= MAX_BATCH_REQUESTS
            start_timer = not flush_now and not self._flush_scheduled
            if start_timer:
                self._flush_scheduled = True
        if flush_now:
            self._flush()
        elif start_timer:
            threading.Thread(target=self._flush_after_window, daemon=True).start()
        return entry.future.result()

    def _flush_after_window(self) -> None:
        """Let concurrent requests join before submitting the batch."""
        self._sleep(self._gather_seconds)
        self._flush()

    def _flush(self) -> None:
        """Submit everything queued, grouped by provider routing, and wait on each batch."""
        with self._lock:
            entries, self._pending = self._pending, []
            self._flush_scheduled = False
        if self._stopped.is_set():
            self._fail(
                entries, BatchAnswer(502, _error("batch_rejected", "The run is stopping; the request was not sent."))
            )
            return
        groups: dict[str, list[_Entry]] = {}
        for entry in entries:
            provider = entry.body.get("provider") or {}
            routing = {field: provider[field] for field in BATCH_ROUTING_FIELDS if provider.get(field) is not None}
            groups.setdefault(json.dumps(routing, sort_keys=True), []).append(entry)
        for key, group in groups.items():
            threading.Thread(target=self._submit_and_wait, args=(json.loads(key), group), daemon=True).start()

    def _submit_and_wait(self, routing: dict[str, Any], entries: list[_Entry]) -> None:
        """Run one batch to a terminal state, answer every waiting request, then delete it.

        Args:
            routing: Endpoint pin and data policy shared by the group.
            entries: The requests in this batch.
        """
        try:
            try:
                batch_id = self._submit(routing, entries)
            except httpx.HTTPStatusError as exc:
                logger.warning("OpenRouter refused a batch for %s: %s", self.model, exc)
                self._fail(entries, BatchAnswer(502, _error("batch_rejected", "The provider rejected the batch.")))
                return
            batch = self._wait(batch_id)
            self._answer(batch, entries)
            if batch is not None:
                self._delete(batch_id)
        except Exception:
            # A submission lost in transit may still have created a billable
            # batch, so its coverage is held for reconciliation, not released.
            logger.exception("OpenRouter batch for %s failed", self.model)
        finally:
            self._fail(entries, _LOST)

    @staticmethod
    def _fail(entries: list[_Entry], answer: BatchAnswer) -> None:
        """Answer every request still waiting, leaving already answered ones alone."""
        for entry in entries:
            if not entry.future.done():
                entry.future.set_result(answer)

    def _submit(self, routing: dict[str, Any], entries: list[_Entry]) -> str:
        """Create the batch and return its id.

        Args:
            routing: Batch-level provider routing for every request.
            entries: The requests in this batch.

        Raises:
            httpx.HTTPError: When the provider refuses the submission.
            ValueError: When the response carries no batch id.
        """
        # OpenRouter reads the batch-level fields before the request list, so
        # they must come first in the serialized body.
        payload: dict[str, Any] = {"endpoint": "/v1/chat/completions", "model": self.model}
        if routing:
            payload["provider"] = dict(routing)
        payload["completion_window"] = "24h"
        payload["requests"] = [
            {
                "custom_id": entry.custom_id,
                "body": {key: value for key, value in entry.body.items() if key not in {"model", "provider"}},
            }
            for entry in entries
        ]
        response = self._client.post(BATCHES_URL, headers=self._headers(), json=payload)
        response.raise_for_status()
        batch_id = response.json().get("id")
        if not isinstance(batch_id, str) or not batch_id:
            raise ValueError("The batch response carried no id.")
        return batch_id

    def _delete(self, batch_id: str) -> None:
        """Purge a finished batch's stored prompts and results from OpenRouter.

        OpenRouter keeps batch inputs and outputs for 30 days unless deleted;
        the answers are already handed out, so nothing here needs them. A failed
        delete is logged, not raised, because every request is already answered.

        Args:
            batch_id: A batch known to be in a terminal state.
        """
        try:
            response = self._client.delete(f"{BATCHES_URL}/{batch_id}", headers=self._headers())
            if response.status_code != 404:
                response.raise_for_status()
        except httpx.HTTPError as exc:
            logger.warning("Deleting OpenRouter batch %s failed; it expires in 30 days: %s", batch_id, exc)

    def _wait(self, batch_id: str) -> dict[str, Any] | None:
        """Poll until the batch is terminal or the deadline passes.

        Returns:
            The terminal batch object, or None when the deadline passed first.
        """
        deadline = self._clock() + self._deadline_seconds
        delay = self._poll_seconds
        while self._clock() < deadline:
            self._sleep(delay)
            if self._stopped.is_set():
                return None
            if self._heartbeat is not None:
                try:
                    self._heartbeat()
                except Exception:  # a lost liveness signal must not abandon a paid batch
                    logger.warning("Economy batch heartbeat failed", exc_info=True)
            try:
                response = self._client.get(f"{BATCHES_URL}/{batch_id}", headers=self._headers())
                response.raise_for_status()
                batch = response.json()
            except (httpx.HTTPError, ValueError) as exc:
                logger.warning("Polling OpenRouter batch %s failed, retrying: %s", batch_id, exc)
                continue
            if isinstance(batch, dict) and batch.get("status") in TERMINAL_STATUSES:
                return batch
            delay = min(delay * 1.5, MAX_POLL_SECONDS)
        return None

    def _answer(self, batch: dict[str, Any] | None, entries: list[_Entry]) -> None:
        """Hand each waiting request its result and its share of the measured bill.

        A request with no result after a terminal batch was never run and is
        refused; a batch lost past its deadline leaves every request
        interrupted, so its coverage is held until the bill can be reconciled.
        """
        if batch is None:
            self._fail(entries, _LOST)
            return
        results = {item.get("custom_id"): item for item in batch.get("results") or [] if isinstance(item, Mapping)}
        answered: list[tuple[_Entry, int, dict[str, Any]]] = []
        for entry in entries:
            item = results.get(entry.custom_id)
            response = item.get("response") if item else None
            if not isinstance(response, Mapping) or not isinstance(response.get("body"), Mapping):
                message = f"The batch ended as {batch.get('status')} before this request ran."
                entry.future.set_result(BatchAnswer(502, _error("batch_incomplete", message)))
                continue
            answered.append((entry, int(response.get("status_code") or 200), dict(response["body"])))
        usage = batch.get("usage") if isinstance(batch.get("usage"), Mapping) else {}
        total = usage.get("cost")
        shares: list[Decimal | None] = [None] * len(answered)
        if total is not None:
            weights = []
            for entry, _, body in answered:
                tokens = body.get("usage") if isinstance(body.get("usage"), Mapping) else {}
                prompt_rate, completion_rate = entry.rates
                weights.append(
                    Decimal(int(tokens.get("prompt_tokens") or 0)) * prompt_rate
                    + Decimal(int(tokens.get("completion_tokens") or 0)) * completion_rate
                )
            shares = list(allocate_cost(exact_nonnegative(total), weights))
        for (entry, status, body), share in zip(answered, shares, strict=True):
            if share is not None:
                body["usage"] = {
                    **(body.get("usage") if isinstance(body.get("usage"), Mapping) else {}),
                    "cost": str(share),
                    "is_byok": usage.get("is_byok", False),
                }
            entry.future.set_result(BatchAnswer(status, json.dumps(body).encode()))

    def stop(self) -> None:
        """Stop waiting so a closing run is not held open by a slow batch.

        Requests already submitted are left interrupted, holding their coverage
        until the bill is reconciled; new requests are refused unsent.
        """
        self._stopped.set()

    def _headers(self) -> dict[str, str]:
        """Authenticate as the route's credential."""
        return {"Authorization": f"Bearer {self._api_key}", "Content-Type": "application/json"}
