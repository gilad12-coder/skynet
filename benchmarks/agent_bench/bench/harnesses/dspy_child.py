"""Child process of the DSPy harness: run one ReAct loop and write its result.

Kept apart from ``dspy_react`` because importing the backend's ReAct class
pulls in the whole service layer, which the benchmark runner must not pay for.
The parent puts the backend on ``PYTHONPATH``.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
from pathlib import Path
from typing import Any

import dspy
from mcp import ClientSession
from mcp.client.streamable_http import streamablehttp_client

from bench.harnesses.base import MODEL
from bench.harnesses.dspy_react import MAX_ITERS
from core.service_gateway.optimization.retrying_react import RetryingReActV2


async def _child(variant: str, port: int, workdir: Path) -> dict[str, Any]:
    """Run the ReAct loop against the world's MCP endpoint and collect usage.

    Args:
        variant: Which ReAct class to build.
        port: Port of the attempt's world server.
        workdir: The attempt directory holding ``message.txt`` and ``brief.txt``.

    Returns:
        The fields of an :class:`Attempt`.
    """
    message = (workdir / "message.txt").read_text()
    brief = (workdir / "brief.txt").read_text()
    lm = dspy.LM(f"openrouter/{MODEL}", api_key=os.environ["OPENROUTER_API_KEY"], cache=False, max_tokens=16000)
    signature = dspy.Signature("user_message: str -> reply: str", brief)
    loop = asyncio.get_running_loop()

    async with (
        streamablehttp_client(f"http://127.0.0.1:{port}/mcp") as (read, write, _),
        ClientSession(read, write) as session,
    ):
        await session.initialize()
        listing = await session.list_tools()

        def bridge(tool: Any) -> Any:
            """Wrap an async MCP tool so the sync ReAct loop, running in a worker thread, can call it."""

            def call(**kwargs: Any) -> Any:
                return asyncio.run_coroutine_threadsafe(tool.acall(**kwargs), loop).result(timeout=120)

            return dspy.Tool(
                call, name=tool.name, desc=tool.desc, args=tool.args, arg_types=tool.arg_types, arg_desc=tool.arg_desc
            )

        tools = [bridge(dspy.Tool.from_mcp_tool(session, t)) for t in listing.tools]
        if variant == "dspy-reactv2":
            program = RetryingReActV2(signature, tools=tools, max_iters=MAX_ITERS, serial_tool_calls=True)
        else:
            program = dspy.ReAct(signature, tools=tools, max_iters=MAX_ITERS)

        error, answer = "", ""
        try:
            with dspy.context(lm=lm):
                prediction = await asyncio.to_thread(program, user_message=message)
            answer = str(getattr(prediction, "reply", "") or "")
        except Exception as exc:
            error = f"{type(exc).__name__}: {exc}"[:300]

    fresh = cached = output = 0
    for entry in lm.history:
        usage = entry.get("usage") or {}
        details = usage.get("prompt_tokens_details")
        # litellm hands the details back as a dict or as a pydantic wrapper.
        hit = (details.get("cached_tokens") if isinstance(details, dict) else getattr(details, "cached_tokens", 0)) or 0
        fresh += (usage.get("prompt_tokens") or 0) - hit
        cached += hit
        output += usage.get("completion_tokens") or 0
    return {
        "answer": answer,
        "fresh_input_tokens": fresh,
        "cached_input_tokens": cached,
        "output_tokens": output,
        "llm_calls": len(lm.history),
        "error": error,
    }


def main() -> None:
    """Child entry point: run one attempt and write ``dspy_result.json``."""
    parser = argparse.ArgumentParser()
    parser.add_argument("variant", choices=["dspy-reactv2", "dspy-react"])
    parser.add_argument("port", type=int)
    parser.add_argument("workdir", type=Path)
    args = parser.parse_args()
    result = asyncio.run(_child(args.variant, args.port, args.workdir))
    (args.workdir / "dspy_result.json").write_text(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    main()
