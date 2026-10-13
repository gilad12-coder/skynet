"""The unified seed streams each parallel lane live and reports its end on its own."""

from __future__ import annotations

import asyncio
from typing import Any

import dspy
import litellm
import pytest
from litellm.types.utils import Delta, ModelResponseStream, StreamingChoices

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


def _token(field: str, text: str) -> dspy.streaming.StreamResponse:
    """Build one streamed token.

    Args:
        field: The signature field the token belongs to.
        text: The token text.

    Returns:
        The stream response.
    """
    return dspy.streaming.StreamResponse(predict_name="p", signature_field_name=field, chunk=text, is_last_chunk=False)


@pytest.mark.asyncio
async def test_seed_stream_forwards_reasoning_and_code_tokens_live() -> None:
    """A lane's reasoning and code reach the queue token by token, tagged with the lane."""

    async def program(**_inputs: Any) -> Any:
        """Think in two tokens, then write the metric in two.

        Yields:
            Reasoning and metric tokens, then the final prediction.
        """
        yield _token(code.REASONING_FIELD, "weigh ")
        yield _token(code.REASONING_FIELD, "recall")
        yield _token("metric_code", "def metric")
        yield _token("metric_code", "(): ...")
        yield dspy.Prediction(metric_code="def metric(): ...")

    queue: asyncio.Queue[dict | None] = asyncio.Queue()
    results: dict[str, Any] = {"metric_code": ""}
    await code._pump_seed_stream(
        program, {}, "metric_code", "metric_patch", queue=queue, results=results, reasoning_source="metric"
    )

    events = [queue.get_nowait() for _ in range(queue.qsize())]
    assert events == [
        {"event": "reasoning_patch", "data": {"chunk": "weigh ", "source": "metric"}},
        {"event": "reasoning_patch", "data": {"chunk": "recall", "source": "metric"}},
        {"event": "metric_patch", "data": {"chunk": "def metric"}},
        {"event": "metric_patch", "data": {"chunk": "(): ..."}},
    ]
    assert results["metric_code"] == "def metric(): ..."


def _provider_chunk(*, content: str | None = None, reasoning: str | None = None) -> ModelResponseStream:
    """Build one raw provider stream chunk, as LiteLLM hands it to DSPy.

    Args:
        content: Answer text carried by the chunk.
        reasoning: Reasoning text carried by the chunk.

    Returns:
        The stream chunk.
    """
    delta = Delta(content=content)
    if reasoning:
        delta.reasoning_content = reasoning
    return ModelResponseStream(choices=[StreamingChoices(delta=delta, index=0)], model="fake")


_RUN_CODE = "def run(artifact, input):\n    return input['review']"
_METRIC_CODE = "def score(output, expected):\n    return 1.0"


async def _fake_acompletion(**request: Any) -> Any:
    """Answer each seed predictor like a provider that sends short answers whole.

    The run code arrives in a single content chunk after its reasoning, which
    is how the preview provider delivered it; the metric and the intro
    message arrive a few characters at a time.

    Args:
        **request: The LiteLLM request DSPy built.

    Returns:
        An async generator of provider chunks.
    """
    prompt = str(request.get("messages"))
    if "Introduce the drafted" in prompt:
        field, text = "assistant_message", "Here it is."
    elif "metric_code" in prompt.split("Your output fields are")[-1][:300]:
        field, text = "metric_code", _METRIC_CODE
    else:
        field, text = "run_code", _RUN_CODE
    body = f"[[ ## {field} ## ]]\n{text}\n\n[[ ## completed ## ]]"
    step = len(body) if field == "run_code" else 4

    async def stream() -> Any:
        """Yield reasoning, then the answer.

        Yields:
            Provider chunks.
        """
        yield _provider_chunk(reasoning="thinking ")
        for start in range(0, len(body), step):
            yield _provider_chunk(content=body[start : start + step])

    return stream()


async def test_run_code_reaches_the_editor_when_the_provider_sends_it_whole(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Through the real DSPy stream listeners, the run code is published before its lane ends.

    DSPy's listener drops a field that arrives in one chunk, so on the preview
    the run editor stayed empty until the whole turn ended.
    """

    async def validate(*, code: str, **_kwargs: Any) -> tuple[str, str]:
        """Accept the code as written.

        Args:
            code: The streamed code.
            **_kwargs: Unused.

        Returns:
            The code and no error.
        """
        return code, ""

    monkeypatch.setattr(litellm, "acompletion", _fake_acompletion)
    monkeypatch.setattr(code, "_validate_and_repair_artifact", validate)
    unified = {
        "task": {"objective": "o", "artifact": {"kind": "prompt", "starting_version": "x"}},
        "input_fields": ["review"],
        "metric_shape": "blackbox_side_info",
    }
    queue: asyncio.Queue[dict | None] = asyncio.Queue()
    results = await code._run_unified_seed(
        lm=dspy.LM("openai/fake", cache=False),
        unified=unified,
        authoring_brief="",
        reply_language="English",
        queue=queue,
    )

    events = [queue.get_nowait() for _ in range(queue.qsize())]
    names = [e["event"] for e in events]
    run_text = "".join(e["data"]["chunk"] for e in events if e["event"] == "signature_patch")
    metric_text = "".join(e["data"]["chunk"] for e in events if e["event"] == "metric_patch")
    assert run_text.strip() == _RUN_CODE
    assert metric_text.strip() == _METRIC_CODE
    run_done = events.index({"event": "artifact_done", "data": {"source": "signature"}})
    assert "signature_patch" in names[:run_done]
    assert results["signature_code"].strip() == _RUN_CODE
