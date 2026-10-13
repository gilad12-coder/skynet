"""The unified seed reports each parallel lane's end on its own."""

from __future__ import annotations

import asyncio
from typing import Any

import pytest

from core.service_gateway.agents import code


def _fake_streamify(*_args: Any, **_kwargs: Any) -> Any:
    """Stand in for ``dspy.streamify``: the intro message streams nothing.

    Returns:
        A program yielding no chunks.
    """

    async def program(**_inputs: Any) -> Any:
        """Yield nothing.

        Yields:
            Never.
        """
        return
        yield

    return program


@pytest.mark.asyncio
async def test_each_lane_emits_artifact_done_when_it_finishes(monkeypatch: pytest.MonkeyPatch) -> None:
    """The fast run lane reports done before the slow metric lane does."""
    metric_may_finish = asyncio.Event()

    async def pump(_program: Any, _inputs: Any, field: str, event: str, **kwargs: Any) -> None:
        """Stream one chunk; the metric lane waits until the run lane is done.

        Args:
            _program: Unused.
            _inputs: Unused.
            field: The output field.
            event: The patch event name.
            **kwargs: ``queue`` and ``results``.
        """
        if field == "metric_code":
            await metric_may_finish.wait()
        kwargs["results"][field] = f"# {field}"
        await kwargs["queue"].put({"event": event, "data": {"chunk": f"# {field}"}})

    async def validate(*, artifact_kind: str, code: str, **_kwargs: Any) -> tuple[str, str]:
        """Accept the code as written.

        Args:
            artifact_kind: The lane name.
            code: The streamed code.
            **_kwargs: Unused.

        Returns:
            The code and no error.
        """
        return code, ""

    monkeypatch.setattr(code, "_pump_seed_stream", pump)
    monkeypatch.setattr(code, "_validate_and_repair_artifact", validate)
    monkeypatch.setattr(code, "_unified_inputs", lambda _u: {"objective": "o"})
    monkeypatch.setattr(code, "_inputs_for", lambda _sig, values: values)
    monkeypatch.setattr(code, "_unified_validators", lambda _u: (lambda c: "", lambda c: ""))
    monkeypatch.setattr(code, "_unified_column_roles", lambda _u: ([], "{}"))
    monkeypatch.setattr(code.dspy, "streamify", _fake_streamify)

    queue: asyncio.Queue[dict | None] = asyncio.Queue()
    seed = asyncio.create_task(
        code._run_unified_seed(lm=None, unified={}, authoring_brief="", reply_language="English", queue=queue)
    )

    events: list[dict] = []
    while not any(e["event"] == "artifact_done" for e in events):
        events.append(await asyncio.wait_for(queue.get(), timeout=5))
    assert events[-1] == {"event": "artifact_done", "data": {"source": "signature"}}
    assert not any(e["event"] == "metric_patch" for e in events)

    metric_may_finish.set()
    results = await asyncio.wait_for(seed, timeout=5)
    while not queue.empty():
        events.append(queue.get_nowait())
    done = [e["data"]["source"] for e in events if e["event"] == "artifact_done"]
    assert done == ["signature", "metric"]
    assert results["signature_code"] == "# run_code"
    assert results["metric_code"] == "# metric_code"
